Shadow rendering in Himalaya employs a hybrid approach that combines **Cascaded Shadow Maps (CSM)** for distant shadows with **Screen-Space Contact Shadows** for fine geometric detail near the camera. This dual-layer architecture ensures both broad coverage across large scenes and precise contact hardening where objects meet the ground. The system is designed around modern Vulkan rendering patterns, leveraging reverse-Z depth buffers, bindless textures, and compute shaders for efficient parallel execution.

The CSM implementation follows the Practical Split Scheme (PSSM) for cascade distribution, with per-cascade orthographic projections that tightly fit camera sub-frustums while capturing shadow casters outside the view through scene AABB extension. Contact shadows operate as a screen-space post-process, ray-marching through the depth buffer to resolve self-shadowing details that would require impractical shadow map resolutions to capture. Together these techniques provide a complete shadow solution that scales from indoor architectural scenes to expansive outdoor environments.

Sources: [shadow.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/shadow.h#L1-L73), [shadow_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h#L1-L155), [contact_shadows_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h#L1-L103)

## Cascaded Shadow Maps Architecture

The CSM system partitions the view frustum into multiple depth ranges (cascades), each rendered into a separate layer of a 2D array texture. This approach maintains consistent shadow texel density across vastly different depth ranges — near objects receive high-resolution shadows while distant elements use coarser sampling without wasting texture memory on empty space.

### Cascade Split Distribution

Cascade boundaries are computed using the PSSM formula that blends logarithmic and linear distributions. The logarithmic component places more cascades near the camera where detail matters most, while the linear component ensures adequate coverage at distance. The blend factor `split_lambda` (typically 0.5-0.8) controls this trade-off:

```
C_log = near × (far/near)^(i/n)
C_lin = near + (far - near) × i/n
C_i   = lambda × C_log + (1 - lambda) × C_lin
```

This distribution is implemented in [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L40-L50), where splits are computed and stored for GPU-side cascade selection. The renderer uploads these splits to `GlobalUniformData.cascade_splits`, enabling the fragment shader to select the appropriate cascade based on view-space depth.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L40-L50), [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L160-L196)

### Light-Space Projection and Stabilization

Each cascade requires an orthographic projection matrix that tightly bounds its camera sub-frustum in XY while extending Z to encompass the scene AABB. This tight fitting maximizes shadow map utilization — a cascade covering a 10-meter sub-frustum receives the full resolution rather than wasting texels on empty space beyond the visible geometry.

The projection construction involves several stabilization techniques:

| Technique | Purpose | Implementation |
|-----------|---------|----------------|
| **Sub-frustum centering** | Numerical precision | Light-view matrix centered on cascade sub-frustum center |
| **Scene AABB Z-extension** | Capture distant casters | Extend light-space Z to scene bounds |
| **Texel snapping** | Prevent edge shimmer | Round VP translation to texel boundaries |

Texel snapping is particularly critical for camera translation stability. Without it, sub-texel camera movements cause shadow edges to shimmer as texels snap between different world positions. The implementation projects world origin through the view-projection matrix, rounds to the nearest texel center, and applies the resulting correction to the VP translation matrix.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L85-L110), [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L140-L155)

### Shadow Map Resources

The shadow pass manages a 2D array image with `kMaxShadowCascades` layers (4), using `D32Sfloat` format for depth precision. Per-layer views are created for rendering into individual cascade layers during the shadow pass execution. The resource layout is:

```
Shadow Map (D32Sfloat, resolution² × 4 layers)
├── Layer 0: Cascade 0 (nearest, highest detail)
├── Layer 1: Cascade 1
├── Layer 2: Cascade 2
└── Layer 3: Cascade 3 (farthest, lowest detail)
```

The shadow pass creates two graphics pipelines: an **opaque pipeline** with no fragment shader (depth written by rasterizer) for maximum Early-Z efficiency, and a **mask pipeline** with alpha test discard for materials with transparency masks. This separation ensures that the majority of geometry (opaque) renders with full hardware depth rejection, while only masked materials pay the cost of fragment shader execution.

Sources: [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L200-L280), [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L90-L130)

### Shadow Sampling and Filtering

The forward pass samples shadows through functions defined in [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl), which provides two filtering modes:

**PCF (Percentage-Closer Filtering)** — A fixed-radius kernel that performs multiple depth comparisons and averages the results. The kernel radius is configurable (0 = single sample hard shadow, 1 = 3×3, up to 5 = 11×11). Each texture fetch leverages hardware 2×2 bilinear comparison, so the effective filter width exceeds the grid dimensions.

**PCSS (Percentage-Closer Soft Shadows)** — Contact-hardening shadows that vary filter width based on blocker distance. The algorithm performs three steps: (1) blocker search in an elliptical region to find average blocker depth, (2) penumbra width estimation from receiver-blocker depth difference, and (3) variable-width PCF using the estimated kernel size. This produces physically plausible soft shadows that harden at contact points and soften with distance.

Sources: [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L250-L350), [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L130-L200)

### Cascade Blending and Distance Fade

To prevent hard boundaries between cascades, the system implements blend regions at cascade far boundaries. When a fragment falls within the blend region (controlled by `shadow_blend_width`), the shader samples both the current and next cascade, linearly interpolating based on position within the blend zone. This creates smooth transitions even when cascade resolutions differ significantly.

Distance fade provides a gradual transition to unshadowed rendering beyond `shadow_max_distance`. Rather than an abrupt cutoff, shadows fade to fully lit over a configurable fraction of the maximum distance (`shadow_distance_fade_width`), preventing jarring pop-in at the shadow boundary.

Sources: [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L350-L400), [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L440-L496)

## Screen-Space Contact Shadows

While CSM provides excellent coverage for large-scale shadows, it cannot resolve fine contact details at practical resolutions. A 2048×2048 shadow map covering 100 meters provides only 2cm texels — insufficient for capturing the precise shadow where a chair leg meets the floor. Contact shadows address this limitation through screen-space ray marching.

### Ray Marching Algorithm

The contact shadows compute shader ([contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp)) traces rays from each pixel toward the primary directional light, sampling the depth buffer to detect occlusion. The algorithm operates in clip space with several key optimizations:

**Non-linear step distribution** — Steps are concentrated near the ray origin using a power curve `(i/N)^exponent` where exponent = 2.0. This places more samples where contact detail matters most while allowing coarser sampling further along the ray.

**Dual depth sampling** — At each step, both bilinear-filtered and nearest-neighbor depths are sampled. Bilinear creates false shadows at silhouettes (interpolates foreground/background), while nearest produces staircase artifacts. Requiring the ray to pass below **both** surfaces eliminates both artifact classes.

**Adaptive step count** — The effective step count is clamped to the screen-space ray length, ensuring no more steps than pixels to traverse. This prevents wasted work on short rays while maintaining quality on long grazing-angle shadows.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L150-L200), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L200-L272)

### Precision and Bias Handling

Contact shadows require careful handling of numerical precision and self-intersection:

| Challenge | Solution |
|-----------|----------|
| Far pixel precision loss | Build `start_clip` directly from known NDC coordinates rather than round-trip through matrices |
| Self-intersection | Slope-scaled depth bias: `bias = tolerance / max(NdotL, 0.25)` |
| Grazing angle artifacts | Clamp bias scale to prevent extreme values at near-tangent angles |
| Camera plane crossing | Clamp ray end to just before camera plane when light is behind camera |

The slope-scaled bias adapts to surface orientation relative to the light — surfaces facing the light (NdotL ≈ 1) receive minimal bias, while grazing angles (NdotL → 0) receive up to 4× more bias to prevent self-shadowing artifacts.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L80-L130), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L130-L160)

### Temporal Stability

Interleaved Gradient Noise (IGN) with per-frame temporal offset converts step banding into high-frequency noise that TAA can resolve. The noise is folded into the step formula as `(i + noise) / N`, producing sub-step variation per pixel. The golden ratio fractional offset (`0.618...`) decorrelates successive frames, ensuring effective sample count multiplication through temporal accumulation.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L160-L180), [noise.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/noise.glsl)

## Integration with Forward Rendering

The forward pass combines CSM and contact shadows to produce the final shadow attenuation factor. The integration follows a specific order to maintain physical correctness:

1. **CSM shadow evaluation** — Sample cascaded shadow maps with PCF or PCSS
2. **Cascade blending** — Blend between adjacent cascades in overlap regions
3. **Distance fade** — Fade shadows to fully lit beyond max distance
4. **Contact shadow multiplication** — Apply contact shadow mask (primary light only)

Contact shadows are applied only to the primary directional light (`directional_lights[0]`) since the compute shader traces rays for a single light direction. The contact shadow mask is sampled from `rt_contact_shadow_mask` and multiplied into the radiance calculation before BRDF evaluation.

The forward shader also provides debug visualization modes for shadow debugging: `DEBUG_MODE_SHADOW_CASCADES` colors pixels by cascade index, and `DEBUG_MODE_CONTACT_SHADOWS` shows the raw contact shadow mask.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L200-L250), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L130-L180)

## Configuration Parameters

The shadow system exposes runtime-tunable parameters through `ShadowConfig` and `ContactShadowConfig`:

### ShadowConfig (CSM)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cascade_count` | uint32 | 4 | Active cascades (1-4) |
| `split_lambda` | float | 0.75 | PSSM log/linear blend |
| `max_distance` | float | 100.0 | Shadow coverage in meters |
| `slope_bias` | float | 2.0 | Hardware depth bias slope |
| `normal_offset` | float | 2.0 | Shader normal offset in texels |
| `pcf_radius` | uint32 | 2 | PCF kernel radius (0=off) |
| `blend_width` | float | 0.1 | Cascade blend region fraction |
| `shadow_mode` | uint32 | 0 | 0=PCF, 1=PCSS |
| `light_angular_diameter` | float | 0.00925 | Light size in radians (sun ≈ 0.53°) |
| `pcss_quality` | uint32 | 1 | 0=Low, 1=Medium, 2=High |

### ContactShadowConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `step_count` | uint32 | 16 | Ray march steps (8/16/24/32) |
| `max_distance` | float | 0.5 | Max search distance in meters |
| `base_thickness` | float | 0.02 | Depth comparison tolerance |

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L160-L260), [application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L173-L210)

## System Architecture

The shadow system spans multiple architectural layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  Application Layer                                               │
│  ├── ShadowConfig / ContactShadowConfig (runtime parameters)    │
│  └── DebugUI (parameter tuning, visualization modes)            │
├─────────────────────────────────────────────────────────────────┤
│  Render Pass Layer                                               │
│  ├── ShadowPass (CSM depth rendering)                           │
│  └── ContactShadowsPass (compute ray marching)                  │
├─────────────────────────────────────────────────────────────────┤
│  Framework Layer                                                 │
│  ├── compute_shadow_cascades() (PSSM split + projection math)   │
│  └── ShadowCascadeResult (per-cascade VP matrices)              │
├─────────────────────────────────────────────────────────────────┤
│  Shader Layer                                                    │
│  ├── shadow.vert / shadow_masked.frag (depth pass)              │
│  ├── contact_shadows.comp (screen-space ray marching)           │
│  └── common/shadow.glsl (sampling, PCF, PCSS, cascade select)   │
└─────────────────────────────────────────────────────────────────┘
```

The [ShadowPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h) manages shadow map resources and rendering, while [ContactShadowsPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h) handles the compute dispatch for screen-space shadows. Both integrate with the [Render Graph System](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system) for automatic synchronization and resource management.

For related lighting systems, see [Ambient Occlusion (GTAO)](https://github.com/1PercentSync/himalaya/blob/main/20-ambient-occlusion-gtao) which provides complementary screen-space occlusion, and [Camera, Lighting, and Shadows](https://github.com/1PercentSync/himalaya/blob/main/15-camera-lighting-and-shadows) for the broader lighting architecture.
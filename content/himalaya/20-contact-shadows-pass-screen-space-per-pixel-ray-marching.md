Traditional shadow mapping (CSM) excels at casting shadows across large scenes but struggles with fine geometry near surfaces — the contact zone where objects meet, crevices between mesh details, and small overhangs that fall between shadow texels. The Contact Shadows pass closes this gap by ray-marching each pixel toward the primary directional light directly in screen space, producing a per-pixel binary shadow mask that complements cascade shadows with sub-texel precision.

The pass operates as a single compute dispatch reading the resolved depth buffer and world-space normal buffer, then writing an R8 mask image consumed by the [Forward Pass](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) to attenuate direct lighting. It integrates into the [Render Graph](https://github.com/1PercentSync/himalaya/blob/main/9-render-graph-automatic-barrier-insertion-and-pass-orchestration) alongside GTAO and CSM, forming the third leg of the engine's shadowing pipeline.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L1-L19), [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L1-L15)

## Data Flow and Pipeline Position

The contact shadows pass sits between AO denoising and the forward pass in the frame's render graph. It consumes two already-resolved render targets and produces a single output image:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Contact Shadows Data Flow                     │
│                                                                  │
│  rt_depth_resolved ──────┐                                      │
│  (Set 2, Bnd 1, D32)     │     ┌──────────────────────┐        │
│                           ├────►│ contact_shadows.comp │        │
│  rt_normal_resolved ─────┘     │  (8×8 workgroups)    │        │
│  (Set 2, Bnd 2, R10G10B10A2)   └──────────┬───────────┘        │
│                                            │                    │
│  GlobalUBO (Set 0, Bnd 0) ────────────────┤                    │
│  LightBuffer (Set 0, Bnd 1) ──────────────┤                    │
│                                            ▼                    │
│                                  contact_shadow_mask            │
│                                  (Set 3, Bnd 0, R8)            │
│                                      │                          │
│                                      ▼                          │
│                            forward.frag samples                 │
│                            rt_contact_shadow_mask               │
│                            (Set 2, Bnd 4)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Render graph pass ordering** in the rasterization path places contact shadows after AO temporal filtering and before the forward pass, with the render graph automatically inserting memory barriers between them:

| Pass Order | Pass Name | Role |
|---|---|---|
| ... | AO Temporal | Produces `ao_filtered` |
| → | **Contact Shadows** | Reads `depth` + `normal`, writes `contact_shadow_mask` |
| → | Forward | Samples `rt_contact_shadow_mask` for direct lighting attenuation |
| → | Skybox | — |

Sources: [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L316-L333), [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L116-L166)

## C++ Pass Architecture

The `ContactShadowsPass` class follows the engine's standard compute pass pattern: a `setup()` / `record()` / `rebuild_pipelines()` / `destroy()` lifecycle with no persistent per-frame state beyond the Vulkan pipeline and its descriptor layout.

```mermaid
classDiagram
    class ContactShadowsPass {
        +setup(ctx, rm, dm, sc)
        +record(rg, ctx)
        +rebuild_pipelines()
        +destroy()
        -create_pipeline()
        -ctx_ : Context*
        -rm_ : ResourceManager*
        -dm_ : DescriptorManager*
        -sc_ : ShaderCompiler*
        -set3_layout_ : VkDescriptorSetLayout
        -pipeline_ : Pipeline
    }
    
    ContactShadowsPass --> "Set 3 Layout" : push descriptor (storage image)
    ContactShadowsPass --> "Compute Pipeline" : compiled contact_shadows.comp
```

**Pipeline setup** creates a push descriptor layout for Set 3 (binding 0 = `VK_DESCRIPTOR_TYPE_STORAGE_IMAGE` for the output mask), then compiles the compute shader via `create_pipeline()`. The pipeline uses all four descriptor sets: Set 0 (global UBO + light buffer), Set 1 (bindless textures — unused but bound for layout compatibility), Set 2 (render targets — depth and normals), and Set 3 (output image via push descriptor).

**Per-frame recording** declares render graph resource usage (read depth, write contact_shadow_mask), binds global descriptor sets, pushes the output image as a Set 3 storage image, and dispatches with workgroup dimensions `ceil(width/8) × ceil(height/8)`. The three tunable parameters — `step_count`, `max_distance`, and `base_thickness` — are passed as 12-byte push constants matching the GPU-side `ContactShadowPushConstants` struct exactly.

Sources: [contact_shadows_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h#L1-L102), [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L21-L112), [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L114-L167)

## Configuration and Runtime Parameters

The pass is controlled through `ContactShadowConfig`, a plain struct held by the application layer and passed into the renderer via `FrameContext`. The debug UI exposes all three parameters with appropriate ranges and presets.

| Parameter | Type | Default | Range | Effect |
|---|---|---|---|---|
| `step_count` | `uint32_t` | 16 | {8, 16, 24, 32} | Number of ray march samples per pixel. Higher values reduce banding at the cost of compute time. |
| `max_distance` | `float` | — | 0.1 – 5.0 m | World-space ray length from surface toward the light. Controls how far the algorithm searches for occluders. |
| `base_thickness` | `float` | — | 0.001 – 0.1 m | Minimum depth tolerance for occlusion detection. Prevents self-shadowing on surfaces with subtle depth variation. |

The feature is toggled via `RenderFeatures::contact_shadows`, which gates both the compute dispatch and the forward pass's mask sampling. The global UBO `feature_flags` bitmask bit 2 (`FEATURE_CONTACT_SHADOWS`) is set when enabled, allowing the shader to conditionally skip sampling.

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L247-L262), [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L449), [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L610-L633), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L56-L61), [renderer.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer.cpp#L69-L71)

## Shader Algorithm — Screen-Space Ray Marching

The compute shader `contact_shadows.comp` implements the core algorithm in four phases: **ray setup**, **self-intersection avoidance**, **adaptive march**, and **hit detection**. Each thread processes one pixel with no shared memory, organized in 8×8 workgroups.

### Phase 1 — Ray Setup and Early Exits

The shader begins with three early-exit conditions that skip the expensive ray march entirely:

1. **No directional light**: If `directional_light_count == 0`, store 1.0 (fully lit) and return.
2. **Sky pixel**: Reverse-Z depth ≤ 0.0 means the pixel is at the far plane (skybox); store 1.0.
3. **Backfacing surface**: Decode the world-space normal from `rt_normal_resolved` and compute `NdotL = dot(normal, ray_dir)`. If `NdotL ≤ 0`, the surface faces away from the light, so the lighting equation already zeroes radiance via NdotL — no shadow calculation needed.

For surviving pixels, the shader reconstructs the ray in **clip space**. Rather than round-tripping through world space for the ray origin (which accumulates floating-point error at distance), it builds `start_clip` directly from the pixel's known NDC coordinates and linearized depth. Only the ray *end* is computed via the full `inv_view_projection → world → offset → view_projection` path, where the slight imprecision merely shifts the ray direction.

A critical guard handles the case where the ray end crosses behind the camera (`clip.w ≤ 0`), which occurs when the sun is behind the camera and the ray toward the light passes through the camera position. The shader clamps the end point to just before the camera plane using a linear interpolation factor.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L64-L131), [depth.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/depth.glsl#L21-L23), [normal.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/normal.glsl#L72-L74)

### Phase 2 — Self-Intersection Avoidance

Ray marching in screen space is notoriously prone to self-shadowing — the ray starts on the surface and immediately detects its own depth as an occluder. The shader applies a multi-layered bias strategy:

**Screen-space skip bias**: Computes the screen-space ray length in pixels and skips the first ~2 pixels of the ray (`t_bias = clamp(2.0 / ray_len_px, 0, 0.1)`). This ensures the first sample doesn't land on the originating surface.

**Slope-scaled depth bias**: Pushes the ray origin toward the camera along the depth axis. The bias scales by `1 / max(NdotL, 0.25)` — a perpendicular surface (NdotL=1) gets 1× tolerance, while grazing-angle surfaces get up to 4×. This mirrors the slope bias in traditional shadow mapping: at grazing angles, the surface depth gradient across pixels is steepest relative to the ray's depth change, requiring proportionally more bias. The clip-space Z adjustment uses the projection matrix relationship: `Δclip.z = projection[3][2] × depth_bias / linear_depth`.

**Adaptive step count**: The effective step count is clamped to `max(2, ray_length_pixels)`, preventing the march from taking more steps than there are pixels to traverse. This avoids wasted computation on very short screen-space rays.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L133-L151), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L164-L185)

### Phase 3 — Non-Linear Ray March

The march distributes samples using a **power-curve** step distribution with exponent 2.0:

```
t = t_bias + pow((i + noise) / N, 2.0) × t_range
```

This quadratic distribution packs more samples near the ray origin where contact detail matters most — small crevices, fine geometry edges, and thin overhangs that are the primary use case for contact shadows. Samples spread out further along the ray where the CSM already provides adequate shadowing.

**Temporal jitter** uses the Interleaved Gradient Noise (IGN) function with the frame counter as an offset, creating a per-pixel pseudo-random sub-step offset that varies each frame. Over multiple frames, TAA accumulates these offset samples, effectively multiplying the effective sample count and converting step-banding artifacts into high-frequency noise that TAA resolves naturally.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L187-L221), [noise.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/noise.glsl#L33-L36)

### Phase 4 — Dual Depth Hit Detection

At each march step, the shader performs **dual depth sampling** — reading both bilinear-filtered and nearest-neighbor depth from the resolved depth buffer:

- **Bilinear-filtered depth** (`texture()`): interpolates across depth discontinuities at silhouette edges, creating phantom surfaces that produce false shadows at object boundaries.
- **Nearest-neighbor depth** (`texelFetch()`): avoids silhouette interpolation but quantizes to texel centers, producing staircase artifacts along diagonal edges.

Requiring the ray to pass below **both** surfaces eliminates both artifact classes simultaneously. The shader takes the `max()` of the two linearized depths (the *farther* surface) and checks whether the ray is behind both — only then is it counted as occluded.

A **dynamic compare tolerance** prevents the ray from registering thick objects (walls, ground planes) as valid contact shadows. The tolerance is proportional to the per-step depth change of the ray (`2 × depth_span / effective_steps`), floored at `base_thickness`. Occluders where the ray-to-surface delta exceeds the tolerance are "thickness failures" — the ray passed entirely through thick geometry — and the march continues to find valid thin occluders behind them.

When a valid hit is detected, shadow intensity fades over the last 25% of the ray (via `smoothstep(0.75, 1.0, t)`) and at screen edges (via `smoothstep` within 5% of viewport boundaries), producing a clean falloff rather than a hard cutoff.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L202-L271)

## Forward Pass Integration

The forward fragment shader samples the contact shadow mask at `screen_uv = gl_FragCoord.xy / screen_size` and multiplies it into the **primary directional light's direct radiance only** (light index 0, matching the compute shader's single-light trace):

```glsl
float contact_shadow = 1.0;
if ((global.feature_flags & FEATURE_CONTACT_SHADOWS) != 0u) {
    contact_shadow = texture(rt_contact_shadow_mask, screen_uv).r;
}
// ... in the light loop ...
if (i == 0u) {
    radiance *= contact_shadow;
}
```

The mask value (1.0 = lit, 0.0 = shadowed) attenuates both diffuse and specular direct lighting from the primary light. It does **not** affect IBL environment lighting — contact shadows are a direct-light occlusion phenomenon. The feature flag guard ensures no texture fetch overhead when the pass is disabled.

A dedicated debug visualization mode (`DEBUG_MODE_CONTACT_SHADOWS = 10`) displays the raw R8 mask as a grayscale image, useful for tuning step count and thickness parameters in isolation.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L150-L157), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L196-L233)

## Resource Management and Descriptor Bindings

The output mask is a render-graph managed image with format `R8Unorm`, created at swapchain-relative resolution (1:1 scale). It uses the `Storage | Sampled` usage flags — written as a storage image by the compute dispatch (Set 3 binding 0), then read as a combined image sampler by the forward pass (Set 2 binding 4, `rt_contact_shadow_mask`).

The descriptor update path follows the engine's standard pattern:

| Event | Action |
|---|---|
| Initialization | `update_contact_shadow_descriptor()` writes Set 2 binding 4 with the managed backing image + linear clamp sampler |
| Swapchain resize | Same update reapplied (managed image may be reallocated) |
| Per-frame Set 2 update | `update_render_target(frame_index, 4, ...)` for frame-pinned descriptor |

The pass requires no managed resources of its own beyond the pipeline and Set 3 layout. The depth buffer (Set 2 binding 1) and normal buffer (Set 2 binding 2) are shared with other passes via the render graph's barrier system.

Sources: [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L129-L141), [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L447), [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L723-L726), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L181-L185)

## Algorithmic Design Rationale

Several interlocking design decisions distinguish this implementation from a naive screen-space ray march:

**Clip-space interpolation with per-step perspective divide** — rather than marching in world space (which wastes precision on distant pixels) or purely in screen space (which distorts ray geometry), the shader interpolates in clip space and performs a per-step `xyz/w` divide. This correctly handles perspective foreshortening: screen-space step sizes naturally grow for distant pixels where less detail is needed.

**Start-clip direct construction** — the ray origin is built from the pixel's known NDC coordinates and linearized depth rather than reconstructing world position and re-projecting. This avoids a `inv_view_projection × view_projection` round-trip that accumulates floating-point error, particularly at distance where reverse-Z depth values are tiny and small absolute errors matter.

**Non-linear step distribution (exponent 2.0)** — concentrating samples near the surface maximizes the algorithm's effectiveness for its primary use case: detecting thin occluders in the first few centimeters. The quadratic falloff means the first 50% of steps cover roughly 25% of the ray, while the last 50% covers the remaining 75%.

**IGN temporal jitter over random** — deterministic pseudo-random noise produces temporally stable patterns that TAA accumulates cleanly, unlike true random which would produce per-frame flickering. The `frame_index` offset ensures each frame's noise pattern shifts, preventing static banding.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L107-L131), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L196-L221)

## Performance Characteristics

The pass runs a fixed-configuration compute dispatch per frame with the following cost profile:

| Aspect | Detail |
|---|---|
| **Workgroup** | 8×8 threads (64 pixels per group, no shared memory) |
| **Per-pixel cost** | `effective_steps` × (1 clip-space `mix()` + 1 perspective divide + 2 depth samples + comparison) |
| **Early exits** | Sky pixels, no-light frames, and backfacing surfaces skip entirely (1 image store) |
| **Output format** | R8Unorm — 1 byte per pixel, minimal bandwidth |
| **Barrier cost** | Render graph inserts one compute-to-fragment barrier before forward pass |

The adaptive step count clamping prevents over-sampling on short screen-space rays (e.g., pixels near the top of the screen where the light direction is nearly parallel to the view direction), ensuring consistent cost regardless of sun angle.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L26-L27), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L145-L151), [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L160-L164)

## Related Pages

- [Shadow Pass — CSM Rendering, PCF, and PCSS Contact-Hardening Soft Shadows](https://github.com/1PercentSync/himalaya/blob/main/18-shadow-pass-csm-rendering-pcf-and-pcss-contact-hardening-soft-shadows) — the cascade shadow system that contact shadows complement
- [GTAO Pass — Horizon-Based Ambient Occlusion with Spatial and Temporal Denoising](https://github.com/1PercentSync/himalaya/blob/main/19-gtao-pass-horizon-based-ambient-occlusion-with-spatial-and-temporal-denoising) — another screen-space effect sharing the same depth/normal inputs
- [Forward Pass — Cook-Torrance PBR, IBL Split-Sum, and Multi-Bounce AO](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) — consumes the contact shadow mask for direct lighting attenuation
- [Render Graph — Automatic Barrier Insertion and Pass Orchestration](https://github.com/1PercentSync/himalaya/blob/main/9-render-graph-automatic-barrier-insertion-and-pass-orchestration) — manages resource transitions between this pass and its neighbors
- [GLSL Shader Architecture — Shared Bindings, BRDF Library, and Feature Flags](https://github.com/1PercentSync/himalaya/blob/main/25-glsl-shader-architecture-shared-bindings-brdf-library-and-feature-flags) — the descriptor set layout and feature flag system used throughout
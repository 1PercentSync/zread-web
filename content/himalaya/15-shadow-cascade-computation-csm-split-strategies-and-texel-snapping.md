Cascaded Shadow Maps (CSM) solve a fundamental problem in real-time shadow rendering: a single shadow texture cannot simultaneously provide high resolution near the camera and adequate coverage across the full view distance. Himalaya's implementation decomposes the camera frustum into multiple depth slices, computes a tight orthographic projection for each, and applies texel snapping to eliminate temporal aliasing. This page covers the **CPU-side cascade computation pipeline** — the geometric algorithms that run every frame in `compute_shadow_cascades()` — and the data contract that bridges the framework layer to both the rendering passes and GPU shaders.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L1-L197), [shadow.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/shadow.h#L1-L72)

## Architecture Overview: The Per-Frame Cascade Pipeline

Every frame, the rasterization path executes a cascade computation sequence: split the frustum into depth slices, build light-space view-projection matrices for each, snap them to texel boundaries, and upload the results to the GPU. The computation is a **pure geometric utility** — it has no Vulkan or RHI dependencies — which keeps it testable and decoupled from rendering infrastructure.

The following diagram shows the end-to-end data flow from scene loading through cascade computation to GPU upload:

```mermaid
flowchart TD
    subgraph "Scene Loading (Once)"
        SL[SceneLoader] -->|"union of instance AABBs"| SB[scene_bounds<br/>AABB]
    end

    subgraph "Per-Frame Cascade Computation"
        CAM[Camera State<br/>position, fov, near/far] --> CSC
        LD[Light Direction] --> CSC
        CFG[ShadowConfig<br/>cascade_count, split_lambda,<br/>max_distance] --> CSC
        SB --> CSC
        TS[shadow_texel_size<br/>1.0 / resolution] --> CSC
        
        CSC[compute_shadow_cascades()] --> PSSM
        PSSM["PSSM Split Distribution<br/>C = λ·C_log + (1-λ)·C_lin"] --> SPLIT[cascade_splits]
        PSSM --> CORNERS["Sub-Frustum<br/>8 Corner Extraction"]
        CORNERS --> LV["Light-View Matrix<br/>(per cascade)"]
        LV --> TIGHT["Tight AABB Fit (XY)<br/>+ Scene Z Extension"]
        TIGHT --> ORTHO["ortho_reverse_z()<br/>Orthographic Projection"]
        ORTHO --> SNAP["Texel Snapping<br/>VP translation correction"]
        SNAP --> RESULT[ShadowCascadeResult]
    end

    subgraph "GPU Data Upload"
        RESULT -->|"memcpy"| UBO["GlobalUniformData<br/>cascade_view_proj, splits,<br/>texel_world_size, extents"]
        RESULT -->|"PCSS derived params"| PCSS["cascade_light_size_uv<br/>cascade_pcss_scale<br/>cascade_uv_scale_y"]
    end
```

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L44-L195), [renderer.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer.cpp#L82-L127), [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L155-L206)

## PSSM Split Distribution — Logarithmic Meets Linear

The depth range covered by shadows is governed by `ShadowConfig::max_distance`, clamped to the camera's far plane: `shadow_far = min(config.max_distance, cam.far_plane)`. This range is then partitioned into N cascades using **Practical Split Shadow Maps (PSSM)**, which blends logarithmic and uniform split schemes via a single parameter `split_lambda`.

The logarithmic scheme distributes texel density proportionally to perspective foreshortening — ideal for visual quality but wasteful for distant geometry. The linear scheme wastes texels near the camera but provides even coverage. PSSM interpolates between them:

| Split Strategy | Formula | Strength | Weakness |
|---|---|---|---|
| **Logarithmic** | `C_log = near × (far/near)^(i/N)` | Matches perspective resolution distribution | Over-allocates to near cascades |
| **Linear** | `C_lin = near + (far - near) × i/N` | Even texel distribution across depth | Poor near-camera resolution |
| **PSSM Blend** | `C = λ × C_log + (1-λ) × C_lin` | Tunable tradeoff | Requires manual λ tuning |

The implementation stores split distances in a fixed-size array with `splits[0] = near_plane` and `splits[1..N]` as the cascade far boundaries. The cascade count is configurable from 1 to 4 via `ShadowConfig::cascade_count`, while `kMaxShadowCascades = 4` fixes the GPU-side array allocation:

```cpp
// PSSM split computation — one line, big impact on shadow quality
const float c_log = cam.near_plane * std::pow(shadow_far / cam.near_plane, t);
const float c_lin = cam.near_plane + (shadow_far - cam.near_plane) * t;
splits[i] = config.split_lambda * c_log + (1.0f - config.split_lambda) * c_lin;
```

The `split_lambda` parameter is exposed in the Debug UI as a slider from 0.0 to 1.0, enabling real-time experimentation. A value around 0.5–0.75 typically yields a good balance for indoor/outdoor scenes. The Debug UI also mirrors this computation to display cascade split distances in a color-coded bar.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L60-L72), [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L22-L26), [scene_data.h (ShadowConfig)](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L160-L165), [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L492-L563)

## Sub-Frustum Corner Extraction

For each cascade slice `[c_near, c_far]`, the algorithm constructs the 8 corners of the camera's truncated view frustum. These corners define the volume of world space that must be captured by this cascade's shadow map. The computation uses the camera's FOV, aspect ratio, and orientation to derive the frustum planes at the near and far depths of each slice:

```cpp
const float nh = c_near * tan_half;     // near half-height
const float nw = nh * cam.aspect;       // near half-width
const float fh = c_far * tan_half;      // far half-height
const float fw = fh * cam.aspect;       // far half-width

const glm::vec3 nc = cam.position + fwd * c_near;  // near center
const glm::vec3 fc = cam.position + fwd * c_far;   // far center
```

The eight corners are computed as the four corners of the near rectangle plus the four corners of the far rectangle, using the camera's `forward` and `right` basis vectors and the derived `up = cross(right, forward)`. These corners serve two purposes: (1) they define the geometric center used as the light-view matrix origin, and (2) they are transformed into light space to compute the tight XY bounding box.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L98-L127)

## Light-Space Basis and View Matrix Construction

A shared orthonormal basis for the light coordinate system is built once and reused across all cascades. The light direction vector (pointing from the light source toward the scene) serves as the Z axis. A stable reference vector is chosen to avoid the degenerate cross product when the light direction is nearly vertical:

```cpp
const glm::vec3 ref = std::abs(light_dir.y) < 0.999f
                          ? glm::vec3(0, 1, 0)    // Y-up reference
                          : glm::vec3(1, 0, 0);    // fallback for vertical lights
const glm::vec3 light_right = normalize(cross(light_dir, ref));
const glm::vec3 light_up    = cross(light_right, light_dir);
```

The **light-view matrix** is constructed per-cascade, centered on the sub-frustum's centroid. This centering improves numerical precision by keeping the translation component small. The matrix is built as a row-major view matrix where the columns are the light basis vectors and the translation offsets negate the dot product of each basis with the center position:

```cpp
const glm::mat4 light_view(
    glm::vec4(light_right.x, light_up.x, -light_dir.x, 0.0f),
    glm::vec4(light_right.y, light_up.y, -light_dir.y, 0.0f),
    glm::vec4(light_right.z, light_up.z, -light_dir.z, 0.0f),
    glm::vec4(-dot(light_right, center),
              -dot(light_up, center),
              dot(light_dir, center), 1.0f));
```

Note the negative sign on the light direction rows — this ensures the light looks along `-Z` in light space, which is the standard convention for right-handed coordinate systems.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L78-L136)

## Tight AABB Fitting and Scene Z Extension

The XY extents of the orthographic projection are determined by transforming the sub-frustum corners into light space and computing a tight axis-aligned bounding box. This minimizes wasted shadow texels on regions outside the camera's view, maximizing effective shadow map resolution.

However, shadow **casters** may exist outside the camera frustum — for example, a tall column just off-screen casting a shadow into view. To handle this, the Z range of the orthographic projection is extended to encompass the entire **scene AABB**, which is computed at load time as the union of all mesh instance world-space bounding boxes:

```cpp
// Tight XY fit from sub-frustum corners
for (const auto& corner : corners) {
    const auto ls = vec3(light_view * vec4(corner, 1.0));
    ls_min = min(ls_min, ls);
    ls_max = max(ls_max, ls);
}

// Z extension from scene AABB (captures off-screen shadow casters)
for (const auto& sc : scene_corners) {
    float lz = vec3(light_view * vec4(sc, 1.0)).z;
    ls_min.z = min(ls_min.z, lz);
    ls_max.z = max(ls_max.z, lz);
}
```

This design choice means XY is tightly fitted (good resolution utilization) while Z is conservatively extended (correct shadow casting). The per-cascade orthographic extents (`cascade_width_x`, `cascade_width_y`, `cascade_depth_range`) are stored in the result for downstream PCSS parameter derivation.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L138-L164), [scene_loader.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/scene_loader.cpp#L672-L681)

## Reverse-Z Orthographic Projection

Himalaya uses a **reverse-Z** depth convention throughout the entire rendering pipeline: the near plane maps to depth 1.0 and the far plane maps to depth 0.0. Combined with a `VK_COMPARE_OP_GREATER` depth test and a clear value of 0.0, this exploits the superior precision distribution of floating-point depth buffers.

The standard `glm::orthoRH_ZO` produces a `[0, 1]` depth mapping with the near plane at 0. To flip it to reverse-Z, the implementation applies the transformation `depth_new = 1 - depth_old`, which modifies only two elements of the projection matrix:

```cpp
glm::mat4 ortho_reverse_z(float left, float right, float bottom, float top,
                           float z_near, float z_far) {
    glm::mat4 m = glm::orthoRH_ZO(left, right, bottom, top, z_near, z_far);
    m[2][2] = -m[2][2];       // negate depth scale
    m[3][2] = 1.0f - m[3][2]; // flip depth offset
    return m;
}
```

The combined light-space view-projection matrix is `light_proj * light_view`, yielding a matrix that transforms world-space positions into the reverse-Z light clip space used by the shadow rendering pass.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L21-L41), [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L160-L166)

## Texel Snapping — Eliminating Shadow Edge Shimmer

When the camera translates, the light-space projection of world geometry shifts by sub-texel amounts in the shadow map. Without correction, this causes **shadow edges to shimmer** — a subtle but distracting temporal aliasing artifact. Texel snapping solves this by rounding the VP matrix's translation component to the nearest shadow texel boundary.

The technique works by observing that for an orthographic projection, the translation column of the combined VP matrix (`vp[3][0]`, `vp[3][1]`) directly determines where the world origin projects in NDC space. By scaling to texel coordinates, rounding to the nearest integer, and computing the correction, the projection is aligned to texel boundaries:

```cpp
const float resolution = 1.0f / shadow_texel_size;
const float half_res   = resolution * 0.5f;
auto& vp = result.cascade_view_proj[c];

// Project world origin → NDC, scale to texel space
const float sx = vp[3][0] * half_res;
const float sy = vp[3][1] * half_res;

// Round to nearest texel center, compute sub-texel correction
vp[3][0] += (std::round(sx) - sx) / half_res;
vp[3][1] += (std::round(sy) - sy) / half_res;
```

The `half_res` factor accounts for the NDC range `[-1, 1]` mapping to `[0, resolution]` in texel space. This ensures that as the camera moves, the shadow projection "jumps" in discrete texel-aligned steps rather than continuously drifting — eliminating the shimmer entirely.

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L168-L183)

## Per-Cascade Texel World Size

After texel snapping, each cascade's **texel world size** is computed — the world-space distance covered by a single shadow map texel. This value is critical for two downstream consumers:

1. **Normal offset bias**: The forward and PCSS shadow sampling functions offset the fragment position along the surface normal by `normal_offset × texel_world_size` to prevent shadow acne on surfaces nearly parallel to the light direction.
2. **PCSS penumbra scaling**: The world-space texel size provides a lower bound for the minimum penumbra width in the PCSS filtering pipeline.

The derivation exploits a mathematical property of the VP matrix: the length of the first row of the VP matrix corresponds to the NDC-to-world scale factor. A full NDC range of `[-1, 1]` (width 2) covers `2 / ||row₀||` world units, so dividing by the resolution yields the per-texel world size:

```cpp
const glm::vec3 row0(vp[0][0], vp[1][0], vp[2][0]);
result.cascade_texel_world_size[c] = 2.0f * shadow_texel_size / glm::length(row0);
```

Sources: [shadow.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/shadow.cpp#L185-L192)

## The Data Contract — ShadowCascadeResult to GlobalUniformData

The `ShadowCascadeResult` struct is the bridge between the framework's pure-math computation and the GPU. It contains everything the shadow rendering and sampling pipeline needs:

| Field | Type | Purpose |
|---|---|---|
| `cascade_view_proj` | `mat4[4]` | Per-cascade reverse-Z, texel-snapped light VP matrices |
| `cascade_splits` | `vec4` | Cascade far boundaries in view-space depth |
| `cascade_texel_world_size` | `vec4` | World-space size of one shadow texel per cascade |
| `cascade_width_x` | `vec4` | Light-space X extent (world units) per cascade |
| `cascade_width_y` | `vec4` | Light-space Y extent (world units) per cascade |
| `cascade_depth_range` | `vec4` | Light-space Z range after scene AABB extension |

The renderer's UBO fill logic copies these directly into `GlobalUniformData` via `memcpy` for the matrix and vec4 fields, then derives three additional PCSS-specific parameters from the orthographic extents:

- **`cascade_light_size_uv`**: `2 × tan(angular_diameter/2) / width_x` — the light source's apparent size in shadow UV space, controlling blocker search radius.
- **`cascade_pcss_scale`**: `depth_range × 2 × tan(angular_diameter/2) / width_x` — maps NDC depth difference to UV penumbra width.
- **`cascade_uv_scale_y`**: `width_x / width_y` — corrects for anisotropic cascade extents (non-square projections).

These derived parameters handle the fact that each cascade's orthographic projection may have different aspect ratios, ensuring PCSS penumbra estimation remains geometrically correct.

Sources: [shadow.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/shadow.h#L28-L46), [renderer.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer.cpp#L90-L127), [scene_data.h (GlobalUniformData)](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L272-L319), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L107-L126)

## Cascade Configuration and Runtime Tuning

The `ShadowConfig` struct holds all user-tunable parameters. It is owned by the application layer, modified directly by the Debug UI, and consumed read-only by the renderer and shadow pass. Key parameters affecting cascade computation:

| Parameter | Range | Default | Effect |
|---|---|---|---|
| `cascade_count` | 1–4 | 4 | Number of depth slices (pure rendering parameter, does not affect shadow map resources) |
| `split_lambda` | 0.0–1.0 | 0.75 | PSSM log/linear blend — higher values favor near-camera detail |
| `max_distance` | 1–2000 | 100 | Maximum shadow coverage in meters (clamped to camera far plane) |
| `normal_offset` | 0.0–5.0 | 1.0 | Normal bias strength (multiplied by texel world size) |
| `slope_bias` | 0.0–10.0 | 2.0 | Hardware depth bias slope factor (negated for reverse-Z) |
| `blend_width` | 0.0–0.5 | 0.1 | Cascade transition region as fraction of split distance |
| `shadow_mode` | 0 or 1 | 0 | 0 = PCF (fixed kernel), 1 = PCSS (contact-hardening) |
| `light_angular_diameter` | radians | 0.00925 | Solar angular diameter (~0.53°), controls PCSS softness |

The cascade count is a **pure rendering parameter** — changing it does not trigger resource recreation. The shadow map is always allocated as a `D32Sfloat` 2D array with 4 layers (at 2048×2048 resolution by default), regardless of the active cascade count. Only the number of layers rendered into and sampled from changes.

Sources: [scene_data.h (ShadowConfig)](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L153-L216), [shadow_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h#L34-L36), [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L280-L303)

## Per-Cascade Frustum Culling Integration

After cascade computation, each cascade's VP matrix is used to construct a culling frustum via `extract_frustum()`. The rasterization path independently culls geometry against each cascade's frustum, building per-cascade draw groups. This is important because each cascade covers a different depth range and a different region of light space — a mesh visible in cascade 0 (near) may be invisible in cascade 3 (far), and vice versa.

The per-cascade culling loop runs for each active cascade, producing separate opaque and alpha-masked draw groups that are consumed by the [Shadow Pass](https://github.com/1PercentSync/himalaya/blob/main/18-shadow-pass-csm-rendering-pcf-and-pcss-contact-hardening-soft-shadows):

```cpp
for (uint32_t c = 0; c < cascade_count; ++c) {
    const auto frustum = extract_frustum(cascades.cascade_view_proj[c]);
    cull_against_frustum(mesh_instances, frustum, shadow_cull_buffer_);
    // ... sort by mesh, build draw groups for opaque + masked
}
```

Sources: [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L177-L206), [culling.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/culling.cpp#L30-L60)

## Shadow Map Resource Layout

The shadow map is a `VkImage` with the following specification, created during `ShadowPass::setup()`:

- **Format**: `D32_SFLOAT` (32-bit floating-point depth)
- **Dimensions**: `2048 × 2048` per layer (configurable via resolution slider)
- **Array layers**: 4 (`kMaxShadowCascades`)
- **Usage**: Depth attachment + sampled (for shadow map comparison sampling)
- **Per-layer views**: Individual `VkImageView`s for rendering into each cascade layer independently

The pass renders into each cascade sequentially within a single render graph pass, using one `vkBeginRendering`/`vkEndRendering` cycle per cascade layer. The depth attachment is cleared to **0.0** (reverse-Z "far" value) at the start of each cascade, and uses `VK_COMPARE_OP_GREATER` for the depth test.

Sources: [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L88-L162), [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L280-L303)

## Next Steps

- **[Shadow Pass — CSM Rendering, PCF, and PCSS Contact-Hardening Soft Shadows](https://github.com/1PercentSync/himalaya/blob/main/18-shadow-pass-csm-rendering-pcf-and-pcss-contact-hardening-soft-shadows)** — how the cascade VP matrices are used to render depth, and how the GPU samples shadows with PCF and PCSS filtering
- **[Forward Pass — Cook-Torrance PBR, IBL Split-Sum, and Multi-Bounce AO](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao)** — how cascade selection and shadow sampling integrate into the main lighting equation
- **[Frustum Culling and Instanced Draw Group Construction](https://github.com/1PercentSync/himalaya/blob/main/14-frustum-culling-and-instanced-draw-group-construction)** — the per-cascade culling pipeline that feeds geometry into the shadow pass
- **[Debug UI — ImGui Panels and Runtime Parameter Tuning](https://github.com/1PercentSync/himalaya/blob/main/24-debug-ui-imgui-panels-and-runtime-parameter-tuning)** — the runtime controls for cascade count, split lambda, and shadow visualization
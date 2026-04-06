The Common Shader Library provides the foundational building blocks shared across all rendering shaders in Himalaya. Rather than duplicating code across vertex, fragment, compute, and ray tracing shaders, this library centralizes mathematical constants, data bindings, BRDF models, normal mapping, shadow sampling, noise generation, and spatial transformations. Understanding this library is essential before diving into any specific rendering pass, as nearly every shader depends on these utilities.

The library follows a strict **dependency hierarchy**: lower-level files (`constants.glsl`) have no dependencies, while higher-level files (`shadow.glsl`) build upon them. This design ensures predictable compilation order and allows shaders to include only what they need. All files use include guards to prevent multiple-definition errors when files include each other transitively.

Sources: [constants.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/constants.glsl#L1-L16), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L205)

## Mathematical Constants

The `constants.glsl` file defines the fundamental mathematical constants used throughout the rendering pipeline. These values are declared as `const float` to enable compile-time optimization and avoid uniform buffer bandwidth.

| Constant | Value | Purpose |
|----------|-------|---------|
| `PI` | 3.14159265358979323846 | Standard π for angular calculations |
| `TWO_PI` | 6.28318530717958647692 | Full circle in radians (optimization) |
| `HALF_PI` | 1.57079632679489661923 | Quarter circle in radians |
| `INV_PI` | 0.31830988618379067154 | Lambertian BRDF normalization (1/π) |
| `EPSILON` | 0.0001 | Small value to prevent division by zero |

The `INV_PI` constant is particularly important for physically-based rendering: the Lambertian diffuse BRDF requires division by π to ensure energy conservation, and using the precomputed inverse avoids a costly division operation per pixel. The `EPSILON` value serves as a guard in visibility functions and other denominators where zero would cause numerical instability.

Sources: [constants.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/constants.glsl#L1-L16)

## Binding Layout and GPU Data Structures

The `bindings.glsl` file defines the **contract between CPU and GPU** — it must exactly match the C++ structures in [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h) and [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h). This file uses Vulkan descriptor set layout with three sets: Set 0 for per-frame global data, Set 1 for bindless textures, and Set 2 for render target intermediates.

### Set 0: Global Frame Data

Set 0 contains all data that changes once per frame. The `GlobalUBO` uniform buffer at binding 0 is the primary source of camera, lighting, and configuration data, occupying 928 bytes in std140 layout. Key fields include view and projection matrices, camera position, screen dimensions, time, and IBL configuration. The shadow system adds cascade view-projection matrices, split distances, and PCSS parameters. Phase 5 additions include inverse projection for GTAO position reconstruction, previous frame's view-projection for temporal reprojection, and frame index for temporal noise.

The SSBOs at bindings 1-3 provide array data: directional lights, material definitions, and per-instance transforms. These use std430 layout for tighter packing. The directional light structure packs direction and intensity into a vec4, and color plus a shadow flag into another vec4. Material data spans 80 bytes containing PBR factors and bindless texture indices. Instance data provides the model matrix, precomputed normal matrix (avoiding per-vertex inverse calculations), and material index.

### Ray Tracing Extensions

When `HIMALAYA_RT` is defined, Set 0 gains three additional bindings for ray tracing. Binding 4 provides the top-level acceleration structure for ray intersection. Binding 5 contains geometry info with device addresses for vertex and index buffers, enabling closest-hit shaders to fetch mesh data. Binding 6 holds the environment map alias table for importance sampling, containing probability weights and redirect indices for efficient environment lighting.

### Set 1: Bindless Texture Arrays

Set 1 implements **bindless texturing** — the modern approach to texture access that eliminates the need for descriptor set updates per draw call. Binding 0 provides an unbounded array of 2D textures, while binding 1 provides cubemap arrays. Materials store indices into these arrays rather than direct bindings, enabling the forward pass to access any texture with a simple array lookup.

### Set 2: Render Target Intermediates

Set 2 contains partially-bound samplers for render pass outputs. These bindings are populated as their producing passes are added to the frame graph. The forward pass samples from `rt_ao_texture` and `rt_shadow_map` when those features are enabled, guarded by feature flags to avoid accessing unwritten bindings.

Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L205), [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L1-L434)

## Physically-Based BRDF

The `brdf.glsl` file implements the **Cook-Torrance microfacet specular model** with GGX distribution, Smith height-correlated visibility, and Schlick Fresnel approximation. This combination represents the industry standard for real-time PBR, balancing physical accuracy with computational efficiency.

### Normal Distribution: D_GGX

The GGX (Trowbridge-Reitz) normal distribution function describes the statistical distribution of microfacet orientations. It takes the dot product between normal and half-vector (NdotH) and linear roughness, returning the concentration of microfacets aligned with the half-vector. The implementation squares roughness to get α (alpha), then computes the characteristic GGX denominator. Higher roughness values spread the distribution, creating broader specular highlights.

### Visibility: V_SmithGGX

The visibility function combines geometry masking and shadowing with the Cook-Torrance denominator into a single term. The implementation uses the **height-correlated Smith approximation** from Heitz 2014, which accounts for the correlation between masking and shadowing at microfacet heights. This produces more accurate results than the uncorrelated version, particularly at grazing angles. The function returns `0.5 / (ggxV + ggxL)` which implicitly includes the `4 * NdotV * NdotL` denominator division.

### Fresnel: F_Schlick

Schlick's approximation provides an efficient Fresnel term estimation, computing reflectance based on the view-half vector dot product (VdotH) and base reflectance (F0). For dielectrics, F0 is typically 0.04 (4% reflectance at normal incidence); for metals, F0 equals the base color. The implementation uses the classic `F0 + (1-F0) * (1-VdotH)^5` formulation.

The complete specular BRDF combines these three terms: `specular = D_GGX(NdotH, roughness) * V_SmithGGX(NdotV, NdotL, roughness) * F_Schlick(VdotH, F0)`. For diffuse, the library uses Lambertian: `diffuse = diffuse_color * INV_PI`.

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L1-L75)

## Normal Mapping Utilities

The `normal.glsl` file handles **tangent-space normal mapping** with robust fallback for degenerate tangents. The primary function `get_shading_normal()` constructs a TBN (tangent-bitangent-normal) matrix from the geometric normal and vertex tangent, decodes the tangent-space normal from the BC5-encoded texture sample, and transforms to world-space.

BC5 encoding stores only the X and Y components of the tangent-space normal; the Z component is reconstructed as `sqrt(1.0 - dot(xy, xy))`. This assumes the normal points outward from the surface (positive Z in tangent space). The function includes a degenerate tangent guard: if the tangent vector has near-zero length, it returns the geometric normal unchanged, preventing NaN propagation from malformed mesh data.

The file also provides **R10G10B10A2 UNORM encoding/decoding** for normal buffer storage. The encoding maps [-1,1] to [0,1] via linear scaling, which preserves the property that averaging encoded values (MSAA resolve) produces the correct average normal after decode and renormalization. This format packs the normal into 32 bits with 10 bits per component, sufficient quality for deferred normals while saving bandwidth versus RGBA16F.

Sources: [normal.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/normal.glsl#L1-L77)

## Depth Utilities

The `depth.glsl` file provides **Reverse-Z depth linearization**. Reverse-Z maps near plane to depth=1 and far plane to depth=0, providing better precision distribution for distant objects. The `linearize_depth()` function converts raw depth to positive linear view-space distance using the projection matrix elements.

The derivation exploits the perspective projection matrix structure: `depth = (P[2][2] * vz + P[3][2]) / (-vz)`. Solving for `-vz` (positive distance) yields `P[3][2] / (depth + P[2][2])`. This avoids the costly matrix inversion that a generic unprojection would require.

Sources: [depth.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/depth.glsl#L1-L26)

## Cascaded Shadow Mapping

The `shadow.glsl` file implements a **complete CSM (Cascaded Shadow Maps) system** with both PCF (Percentage-Closer Filtering) and PCSS (Percentage-Closer Soft Shadows) modes. This is the most complex file in the common library, providing decomposed functions that the forward pass assembles.

### Poisson Disk Sampling

The file includes two precomputed Poisson Disk sample sets: 32 samples for blocker search and 49 samples for PCF filtering. These were generated by `scripts/generate_poisson_disk.py` with minimum distance constraints to ensure good spatial distribution. Each sample set is rotated per-pixel using interleaved gradient noise to prevent banding artifacts.

### Cascade Selection

`select_cascade()` determines which shadow cascade covers a given view-space depth by comparing against the cascade split distances. It also computes a blend factor for the transition region between cascades, enabling smooth cross-fade rather than hard boundaries.

### PCF Sampling

`sample_shadow_pcf()` performs hardware-accelerated shadow comparison with optional grid filtering. The kernel radius is configurable via `shadow_pcf_radius` — a radius of 0 gives hard shadows, while larger values expand the filter footprint. Each texture sample on `sampler2DArrayShadow` performs a 2x2 bilinear comparison, so the effective filter is wider than the grid spacing.

### PCSS (Contact-Hardening Shadows)

The PCSS implementation follows the three-step algorithm: **blocker search**, **penumbra estimation**, and **variable-width PCF**. The `prepare_shadow_proj()` function precomputes projection data including receiver plane depth gradients via screen-space derivatives. These gradients enable per-sample depth bias that prevents surface acne without over-biasing.

`blocker_search()` samples raw depth values in an elliptical region to find average blocker depth. The search radius scales with the light's angular size and cascade distance. `sample_shadow_pcss()` converts blocker-receiver depth difference to penumbra width, clamps to reasonable bounds, then performs PCF with the variable kernel size. The result is contact-hardening: sharp shadows where casters contact receivers, softening with distance.

The `blend_cascade_shadow()` function provides the unified entry point, handling cascade selection, PCF/PCSS mode branching, cascade blending, and distance fade in a single call.

Sources: [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L1-L496)

## Noise Generation

The `noise.glsl` file provides **interleaved gradient noise** following Jorge Jimenez's Call of Duty: Advanced Warfare implementation. This noise function produces a deterministic pseudo-random value in [0,1) based on pixel position, suitable for per-pixel jitter without temporal accumulation.

The base function uses the classic formula: `fract(52.9829189 * fract(dot(screen_pos, vec2(0.06711056, 0.00583715))))`. The temporal variant adds a frame-dependent offset using the golden ratio: `screen_pos += float(frame) * 5.588238`. This ensures that TAA (Temporal Anti-Aliasing) accumulates different noise patterns across frames, effectively multiplying the sample count.

Sources: [noise.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/noise.glsl#L1-L39)

## Spatial Transformations

The `transform.glsl` file provides utility functions for coordinate transformations. Currently, it contains `rotate_y()` for rotating direction vectors around the Y-axis using precomputed sine and cosine values. This is primarily used for IBL environment rotation, allowing the skybox and reflection probes to rotate with a user-controlled yaw angle without regenerating the cubemap.

Sources: [transform.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/transform.glsl#L1-L22)

## Path Tracing Extensions

The ray tracing shaders extend the common library through `rt/pt_common.glsl`, which builds upon the core BRDF and transform utilities. This file defines ray payloads for primary and shadow rays, buffer references for vertex/index data access, and comprehensive sampling functions for path tracing.

### Vertex Attribute Interpolation

The `interpolate_hit()` function fetches triangle indices and vertex data via buffer references using the device addresses stored in `GeometryInfo`. It performs barycentric interpolation of position, normal, tangent, and UV coordinates. The function also computes the face normal from triangle edge cross products for geometric consistency checks.

### Quasi-Random Sampling

Path tracing uses **Sobol quasi-random sequences** for low-discrepancy sampling, falling back to PCG hash for dimensions beyond the 128-dimension table. The `rand_pt()` function combines Sobol sequences with Cranley-Patterson rotation using blue noise offsets, providing decorrelated samples across pixels and frames.

### BRDF Importance Sampling

The library implements **GGX VNDF (Visible Normal Distribution Function) importance sampling** following Heitz 2018. This samples half-vectors weighted by the masking function, producing zero-weight samples only for back-facing microfacets. The `sample_ggx_vndf()` function transforms the view direction to a hemisphere configuration, samples a projected disk, then reprojects to the ellipsoid. The corresponding PDF function enables multiple importance sampling with environment lighting.

### Russian Roulette

`russian_roulette()` provides path termination for bounce >= 2, with survival probability based on throughput luminance clamped to [0.05, 0.95]. This prevents infinite paths while maintaining unbiased results through probability division on survival.

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L1-L506)

## Usage Patterns

Shaders include common library files based on their needs:

| Shader Type | Typical Includes |
|-------------|------------------|
| Vertex shaders | `bindings.glsl` |
| Fragment shaders | `bindings.glsl`, `normal.glsl`, `brdf.glsl`, `shadow.glsl` |
| Compute shaders | `bindings.glsl`, `constants.glsl`, `noise.glsl` |
| Ray tracing | `bindings.glsl` (with `HIMALAYA_RT`), `pt_common.glsl` |

The forward fragment shader demonstrates the full pattern: it includes bindings for data access, normal.glsl for normal mapping, brdf.glsl for lighting calculations, shadow.glsl for shadow attenuation, and transform.glsl for IBL rotation. Ray generation shaders define `HIMALAYA_RT` before including bindings to activate the RT-specific descriptors, then include pt_common for sampling utilities.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag), [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen)

## CPU-GPU Contract Verification

The binding layout requires exact matching between C++ and GLSL. The codebase enforces this through `static_assert` statements in [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h) that verify structure sizes and field offsets at compile time. Key assertions include:

- `GlobalUniformData`: 928 bytes (std140 layout)
- `GPUDirectionalLight`: 32 bytes (std430)
- `GPUInstanceData`: 128 bytes (std430)
- `GPUMaterialData`: 80 bytes (std430)

When adding new fields to either side, developers must update both the GLSL struct definition and the C++ struct, then adjust the corresponding offset assertions. Mismatches manifest as silent data corruption on GPU, making these assertions critical for debugging.

## Related Documentation

- [Material System and PBR](https://github.com/1PercentSync/himalaya/blob/main/13-material-system-and-pbr) — CPU-side material management and texture binding
- [Vertex and Fragment Shaders](https://github.com/1PercentSync/himalaya/blob/main/28-vertex-and-fragment-shaders) — Forward pass implementation using these utilities
- [Ray Tracing Shaders](https://github.com/1PercentSync/himalaya/blob/main/30-ray-tracing-shaders) — RT passes extending the common library
- [Shadow Mapping (CSM) and Contact Shadows](https://github.com/1PercentSync/himalaya/blob/main/19-shadow-mapping-csm-and-contact-shadows) — Shadow system architecture
- [Path Tracing Reference View](https://github.com/1PercentSync/himalaya/blob/main/21-path-tracing-reference-view) — Full path tracing implementation
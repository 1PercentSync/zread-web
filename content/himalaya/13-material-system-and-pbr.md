The material system in Himalaya implements a physically-based rendering (PBR) pipeline following the glTF 2.0 metallic-roughness workflow. It bridges the gap between artist-authored material definitions and GPU-friendly data structures, providing a unified material representation that serves both rasterization and ray tracing render paths.

## Core Design Philosophy

Himalaya's material system adopts a **data-oriented design** centered on a single GPU storage buffer (SSBO) containing all scene materials. This approach eliminates per-draw material state changes and enables efficient bindless texture access. The system is intentionally streamlined for the Milestone 1 scope: it supports the standard metallic-roughness workflow with five texture slots, three alpha modes, and no runtime material parameter animation.

The design prioritizes **cache efficiency** and **SIMD-friendliness**. Each material occupies exactly 80 bytes with std430 alignment, allowing the GPU to fetch multiple materials within a single cache line. Texture references use 32-bit bindless indices rather than handles or descriptors, enabling array-style access in shaders without dynamic descriptor indexing overhead.

Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L1-L160), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L205)

## GPU Material Data Layout

The `GPUMaterialData` structure represents the authoritative material definition used by both CPU and GPU. Its layout is carefully designed to match std430 alignment requirements while keeping frequently accessed fields early in the structure:

| Field | Offset | Size | Description |
|-------|--------|------|-------------|
| `base_color_factor` | 0 | 16 bytes | RGBA multiplier for base color texture |
| `emissive_factor` | 16 | 16 bytes | RGB emissive intensity (W unused) |
| `metallic_factor` | 32 | 4 bytes | Metallic multiplier [0, 1] |
| `roughness_factor` | 36 | 4 bytes | Roughness multiplier [0, 1] |
| `normal_scale` | 40 | 4 bytes | Normal map intensity scale |
| `occlusion_strength` | 44 | 4 bytes | AO texture strength multiplier |
| `base_color_tex` | 48 | 4 bytes | Bindless index for base color |
| `emissive_tex` | 52 | 4 bytes | Bindless index for emissive |
| `metallic_roughness_tex` | 56 | 4 bytes | Bindless index for metallic-roughness |
| `normal_tex` | 60 | 4 bytes | Bindless index for normal map |
| `occlusion_tex` | 64 | 4 bytes | Bindless index for occlusion |
| `alpha_cutoff` | 68 | 4 bytes | Alpha test threshold for Mask mode |
| `alpha_mode` | 72 | 4 bytes | 0=Opaque, 1=Mask, 2=Blend |
| `_padding` | 76 | 4 bytes | Alignment padding |

The 80-byte size is verified via `static_assert` to ensure CPU/GPU structure matching. All texture indices reference the global bindless texture array at Set 1, Binding 0. A value of `UINT32_MAX` indicates an unset texture slot, which gets replaced with appropriate default textures during material upload.

Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L45-L65), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L45-L65)

## Material SSBO Management

The `MaterialSystem` class manages the lifecycle of the global material buffer. Unlike systems that pre-allocate for worst-case scenarios, Himalaya creates an exactly-sized SSBO based on the actual material count of the loaded scene. This approach minimizes VRAM overhead for scenes with few materials while supporting scene switching through buffer recreation.

The upload process follows a three-phase pattern: first, the scene loader constructs `GPUMaterialData` entries from glTF material definitions; second, `MaterialSystem::upload_materials()` creates a GPU-only buffer and stages the data; third, the descriptor manager writes the buffer reference to both per-frame Set 0 instances at binding 2. This design ensures that frame-in-flight rendering always accesses consistent material data without synchronization overhead.

Default texture handling occurs during material preparation rather than shader execution. The `fill_material_defaults()` function patches unset texture indices with 1x1 fallback textures: white for base color and metallic-roughness, flat normal (0.5, 0.5, 1.0) for normal maps, and black for emissive. This guarantees that shaders can unconditionally sample all material textures without branching on validity.

Sources: [material_system.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/material_system.cpp#L1-L90), [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L100-L160)

## PBR Shader Implementation

The physically-based shading model follows the Cook-Torrance microfacet BRDF with GGX normal distribution, height-correlated Smith visibility function, and Schlick Fresnel approximation. This combination represents the industry standard for real-time PBR, balancing visual quality with computational efficiency.

The BRDF is factored into diffuse and specular terms. The diffuse component uses Lambertian reflection scaled by `(1 - F) * (1 - metallic)` to conserve energy. The specular component combines three factors: D_GGX for microfacet distribution, V_SmithGGX for geometry masking and shadowing, and F_Schlick for Fresnel reflectance. The visibility function incorporates the Cook-Torrance denominator, yielding the simplified form `specular = D * V * F` without additional division.

For importance sampling in path tracing, the system implements **GGX VNDF sampling** following Heitz 2018. This samples visible normals directly rather than the distribution of all microfacet normals, producing significantly lower variance for rough surfaces. The implementation includes probability density computation for multiple importance sampling (MIS) with environment map lighting.

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L1-L75), [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L280-L340)

## Texture Processing Pipeline

Material textures undergo a multi-stage processing pipeline optimized for both quality and load-time performance. The pipeline distinguishes three texture roles that determine GPU format and processing:

- **Color** (base color, emissive): BC7_SRGB format with sRGB filtering for gamma-correct mip generation
- **Linear** (metallic-roughness, occlusion): BC7_UNORM format with linear filtering
- **Normal**: BC5_UNORM format storing only X and Y channels, with Z reconstructed in shader

The processing follows a parallel CPU compression strategy. First, unique texture references are collected across all materials. Then, source images are hashed for cache lookup; cache hits skip decoding entirely. Misses are decoded, mipmapped via stb_image_resize2 (with sRGB-aware filtering for color textures), and compressed using ISPC-accelerated BC7 encoding. The final GPU upload occurs serially to avoid Vulkan command buffer races.

Normal maps receive special handling: they are compressed to BC5_RG_UNORM, storing only the X and Y components. The shader reconstructs Z using `z = sqrt(1 - x² - y²)`, which preserves precision and reduces bandwidth compared to RGB storage. The normal scale parameter applies during reconstruction, allowing artists to adjust bump intensity without texture reprocessing.

Sources: [texture.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/texture.h#L1-L100), [texture.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/texture.cpp#L1-L200)

## Forward Rendering Integration

The forward pass shader (`forward.frag`) demonstrates the complete material evaluation pipeline. It samples all five material textures, constructs the shading normal via TBN matrix transformation, separates metallic workflow parameters, and combines direct lighting with image-based lighting (IBL).

The shader implements several debug visualization modes accessible via the `debug_render_mode` uniform: normal direction, metallic/roughness values, ambient occlusion composition, and cascade visualization for shadow debugging. These modes bypass lighting calculations for immediate feedback during content iteration.

Ambient occlusion combines material AO (baked texture) with screen-space GTAO through multi-bounce color compensation. This Jimenez 2016 technique prevents over-darkening on high-albedo surfaces by modeling inter-reflection in occluded regions. Specular occlusion uses either the Lagarde approximation or GTSO (Ground-Truth Specular Occlusion) based on the `ao_so_mode` setting, with GTSO providing more accurate results when bent normal data is available.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L1-L200), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L200-L308)

## Path Tracing Integration

The closest-hit shader (`closesthit.rchit`) shares the same material data structure but implements full Monte Carlo integration. It performs vertex attribute interpolation via buffer references, applies normal mapping with consistency correction against the geometric normal, and evaluates multi-lobe BRDF sampling.

The shading normal consistency check prevents light leaks caused by normal mapping pushing the shading vector below the geometric surface. When `dot(N_shading, N_geo) < 0`, the shader reflects the shading normal across the geometric normal, ensuring all lighting calculations occur in the valid hemisphere.

BRDF sampling uses a multi-lobe approach: Fresnel-weighted probability selects between specular (GGX VNDF) and diffuse (cosine-weighted hemisphere) lobes. The selected lobe generates a direction, and throughput is computed as `BRDF * cos(theta) / PDF / lobe_probability`. Russian roulette terminates low-contribution paths after two bounces, with survival probability based on throughput luminance.

Sources: [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L1-L150), [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L200-L314)

## Alpha Mode Handling

The material system supports three alpha modes matching glTF 2.0 semantics:

| Mode | Behavior | Pass Routing |
|------|----------|--------------|
| **Opaque** | Alpha ignored, full coverage | Opaque forward pass |
| **Mask** | Alpha test with discard if below cutoff | Opaque forward pass (early discard) |
| **Blend** | Alpha blending, back-to-front sort | Transparent pass (not implemented in M1) |

Alpha masking occurs in the fragment shader via `discard` when `alpha_mode == 1 && base_color.a < alpha_cutoff`. This approach allows masked materials to use the same pipeline state as opaque materials, avoiding the performance cost of alpha-to-coverage or blending. The alpha cutoff value is configurable per material, defaulting to 0.5 as per glTF specification.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L80-L95), [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L25-L35)

## Integration with Scene Loading

The scene loader (`scene_loader.cpp`) bridges glTF material definitions to the engine's material system. For each glTF material, it extracts PBR parameters, resolves texture references through the bindless system, and constructs `GPUMaterialData` entries. The loader handles glTF's texture coordinate sets, sampler configurations, and factor/texture combinations where both scalar factors and texture samples contribute to final values.

Texture deduplication occurs via `(texture_index, role)` pairs, ensuring that identical textures used in different material slots (or across materials) share GPU memory. The parallel compression pipeline processes unique textures across multiple CPU cores before serial GPU upload, maximizing throughput for scenes with many materials.

Sources: [scene_loader.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/scene_loader.cpp#L400-L600)

## Performance Considerations

The material system is designed for cache-friendly access patterns. The material SSBO uses `readonly` qualifier in shaders, enabling compiler optimizations for buffer loading. Bindless texture access through array indexing eliminates descriptor set updates per draw call, reducing CPU overhead and enabling GPU-driven rendering paths.

Memory bandwidth is minimized through BC compression: BC7 provides 4:1 compression for color textures, while BC5 provides 2:1 for normals with equivalent quality to uncompressed RGBA8. The 80-byte material structure fits within two cache lines on modern GPUs, ensuring that material fetches rarely incur cache misses even with random access patterns from ray tracing incoherence.

Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L130-L140)

## Further Reading

- For the rendering passes that consume material data, see [Depth PrePass and Forward Rendering](https://github.com/1PercentSync/himalaya/blob/main/18-depth-prepass-and-forward-rendering) and [Path Tracing Reference View](https://github.com/1PercentSync/himalaya/blob/main/21-path-tracing-reference-view)
- For texture loading and compression details, see [IBL and Texture Processing](https://github.com/1PercentSync/himalaya/blob/main/17-ibl-and-texture-processing)
- For scene loading implementation, see [Scene Loading (glTF)](https://github.com/1PercentSync/himalaya/blob/main/25-scene-loading-gltf)
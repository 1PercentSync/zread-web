Compute shaders in Himalaya provide GPU-based parallel processing for screen-space effects, image processing, and offline texture generation. Unlike vertex and fragment shaders that operate within a graphics pipeline, compute shaders execute arbitrary parallel computations organized into workgroups, making them ideal for algorithms that process images or buffers without rasterization overhead.

## Compute Shader Architecture

Himalaya's compute shader system follows a consistent pattern across all implementations. Each compute shader operates within a unified descriptor set layout where Set 0 contains per-frame global data (matrices, lights, screen dimensions), Set 1 provides bindless texture arrays, Set 2 exposes render target intermediates from previous passes, and Set 3 uses push descriptors for per-dispatch inputs and outputs. This design enables compute passes to read from screen-space buffers like depth and normals while writing results to storage images, all without requiring persistent descriptor set allocation.

The RHI abstraction wraps Vulkan compute pipeline creation through `create_compute_pipeline()`, which accepts a compute shader module, descriptor set layouts, and push constant ranges. The resulting `Pipeline` structure contains both the `VkPipeline` and its `VkPipelineLayout`, destroyed together when no longer needed. Work dispatch occurs through `CommandBuffer::dispatch()` with three-dimensional group counts calculated from the output image dimensions and the shader's declared local workgroup size.

Sources: [pipeline.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/pipeline.h#L100-L124), [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L174-L188), [pipeline.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/pipeline.cpp#L153-L189)

## Screen-Space Ambient Occlusion (GTAO)

The Ground-Truth Ambient Occlusion implementation represents the most sophisticated compute shader in the codebase, implementing the full Jimenez 2016 GTAO algorithm with bent normal computation. The shader dispatches at 8x8 workgroups with one thread per pixel, reading resolved depth and normal buffers to produce an RGBA8 output where RGB encodes the bent normal and A contains the diffuse occlusion value.

The algorithm reconstructs view-space positions from depth using the inverse projection matrix, accounting for the Y-flipped viewport where screen Y increases downward while NDC Y increases upward. For each pixel, it performs structured horizon search along multiple directions, sampling the depth buffer with a quadratic power curve that clusters samples near the center where crevice detail matters most. The cosine-weighted visibility integral evaluates analytically using the GTAO paper's equation 10, with thin occluder compensation blending results toward the tangent plane to handle fine geometry.

Bent normal computation follows Algorithm 2 from the GTAO paper, using trigonometric identity expansions to compute the cosine-weighted mean unoccluded direction without additional transcendental function calls. Triple-angle formulas expand sin(3x) and cos(3x), while product identities handle angle sum and difference terms, producing the final bent vector entirely through arithmetic operations on the horizon angles.

Sources: [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L1-L286), [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L1-L177)

## Contact Shadows

Screen-space contact shadows provide high-frequency shadow detail near geometry intersections through ray marching in clip space. The compute shader dispatches in 8x8 workgroups, reading depth and directional light data to produce an R8 contact shadow mask where 1.0 indicates fully lit and 0.0 indicates fully shadowed pixels.

The ray setup builds start_clip directly from known NDC coordinates to avoid the precision loss inherent in matrix round-trips, particularly critical for distant pixels where small absolute errors in tiny NDC depth values cause visible artifacts. The ray direction points toward the primary directional light, with early-out for backfacing surfaces where NdotL ≤ 0. Self-intersection bias computes screen-space ray length to skip approximately the first two pixels, preventing the starting surface from registering as its own occluder.

Ray marching employs non-linear step distribution using an exponent of 2.0, concentrating samples near the ray origin where contact detail matters most. Dual depth sampling at each step reads both bilinear-filtered and nearest-neighbor depth values, requiring the ray to pass below both surfaces to count as occluded. This approach eliminates bilinear phantom shadows at silhouettes while avoiding the staircase artifacts from pure nearest-neighbor sampling. Dynamic compare tolerance scales with the per-step depth change, adapting to varying surface orientations.

Sources: [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L1-L272)

## AO Denoising Pipeline

The ambient occlusion system includes two dedicated compute shaders for temporal stability and spatial smoothing. The spatial filter implements a 5x5 edge-aware bilateral blur using Gaussian spatial weights combined with depth-based bilateral edge weights. Rather than simple depth difference tests, it computes path-accumulated edge weights that prevent "tunneling" through thin geometry. Even if the center and sample pixels share similar depths, an intervening depth discontinuity drives the accumulated weight to zero, correctly preserving edges between same-depth surfaces separated by thin gaps.

The temporal filter blends current-frame spatially denoised AO with the previous frame's filtered result using three-layer rejection. First, UV validity checks whether the reprojected pixel was off-screen last frame. Second, depth consistency compares linearized expected and stored previous-frame depths using relative thresholds for scene-scale independence. Third, neighborhood clamping gathers 3x3 min/max from the current frame and clamps the history AO into that range, preventing ghosting while allowing the bent normal to blend without clamping since direction vector min/max lacks physical meaning.

Sources: [ao_spatial.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_spatial.comp#L1-L158), [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L1-L182)

## Image-Based Lighting Generation

Four compute shaders handle offline IBL texture generation, converting equirectangular HDR environment maps into the cubemap resources used by the forward shading pass. The equirectangular-to-cubemap conversion dispatches as (ceil(size/16), ceil(size/16), 6), with the Z dimension selecting the cubemap face. Each invocation converts spherical coordinates to Cartesian direction vectors, then samples the source equirect texture.

Irradiance cubemap generation performs cosine-weighted hemisphere convolution via uniform angular stepping in spherical coordinates. For each output texel, it builds a tangent frame around the surface normal and accumulates environment samples weighted by cos(theta) * sin(theta), where the cosine implements Lambert's law and the sine provides the spherical coordinate Jacobian. Firefly rejection clamps sampled radiance to prevent extreme HDR values like sun disks from dominating the integration.

Prefiltered environment generation produces roughness-dependent specular reflection cubemaps using GGX importance sampling. For each mip level representing a different roughness, the shader importance-samples the GGX distribution to generate half-vectors, reflects the view vector to produce light directions, and samples the environment with PDF-based mip selection. The solid angle computation selects appropriate mip levels where texel size matches sample footprint, reducing aliasing while maintaining energy conservation.

The BRDF integration LUT computes the split-sum approximation's second term, integrating the GGX BRDF over the hemisphere for each (NdotV, roughness) pair to produce (scale, bias) values such that F_integrated = F0 * scale + bias. This 2D lookup table remains environment-independent and shared across all IBL scenarios.

Sources: [equirect_to_cubemap.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/equirect_to_cubemap.comp#L1-L51), [irradiance.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/irradiance.comp#L1-L72), [prefilter.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/prefilter.comp#L1-L80), [brdf_lut.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/brdf_lut.comp#L1-L92)

## BC6H Texture Compression

The BC6H compute shader provides GPU-accelerated HDR texture compression for environment map storage. Ported from the Betsy GPU compressor with extensions for least-squares endpoint refinement, each invocation compresses one 4x4 texel block into 128 bits. Quality mode tries mode 11 with 10-bit endpoints plus all 32 two-subset partition patterns, selecting the configuration with lowest mean square log error.

The algorithm quantizes endpoints to 7, 9, or 10 bits depending on the mode, then performs three iterations of least-squares refinement to recompute optimal endpoints by minimizing interpolation error across all 16 texels. This significantly reduces error for blocks where simple min/max endpoints prove suboptimal, such as when a single outlier texel pulls an endpoint to an extreme value. The final output writes to an SSBO as uvec4 per block in linear row-major layout.

Sources: [bc6h.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/compress/bc6h.comp#L1-L200)

## Shared Shader Utilities

Compute shaders share common functionality through GLSL includes. The `bindings.glsl` header defines the global descriptor set layout with per-frame matrices, lighting data, and bindless texture arrays, ensuring C++ and shader structures remain synchronized. The `constants.glsl` header provides mathematical constants including PI, EPSILON, and inverse trigonometric values. For IBL operations, `ibl_common.glsl` implements Hammersley quasi-random sequence generation, GGX importance sampling, and cubemap direction conversion utilities.

Workgroup sizing follows consistent patterns: screen-space effects use 8x8 threads matching typical wavefront sizes and providing good occupancy across various GPU architectures, while IBL generation uses 16x16 to maximize throughput for the larger dispatch dimensions. All shaders include explicit bounds checking against image dimensions to handle non-power-of-two resolutions and partial workgroups at image edges.

Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L200), [constants.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/constants.glsl#L1-L16), [ibl_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/ibl_common.glsl#L1-L87)

## Integration with Render Graph

Compute passes integrate into the render graph system by declaring resource usage through `RGResourceUsage` structures specifying read or write access and the compute pipeline stage. The pass callback receives a `CommandBuffer` reference and performs pipeline binding, descriptor set attachment, push constant updates, and workgroup dispatch calculation. Push descriptors for per-dispatch outputs avoid descriptor set allocation overhead, particularly important for passes that execute every frame with varying output images.

The dispatch grid calculation follows the pattern `(dimension + workgroup_size - 1) / workgroup_size` for each axis, ensuring complete coverage even when image dimensions are not multiples of the workgroup size. This ceiling division guarantees every output pixel receives exactly one thread invocation while maintaining the shader's assumption of one-to-one thread-to-pixel mapping.

Sources: [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L116-L175)

## Further Reading

- [Common Shader Library (BRDF, Bindings)](https://github.com/1PercentSync/himalaya/blob/main/27-common-shader-library-brdf-bindings) — Shared shader infrastructure and BRDF implementations
- [Vertex and Fragment Shaders](https://github.com/1PercentSync/himalaya/blob/main/28-vertex-and-fragment-shaders) — Graphics pipeline shader counterparts
- [Ambient Occlusion (GTAO)](https://github.com/1PercentSync/himalaya/blob/main/20-ambient-occlusion-gtao) — Complete AO system documentation
- [IBL and Texture Processing](https://github.com/1PercentSync/himalaya/blob/main/17-ibl-and-texture-processing) — Environment lighting generation details
- [Pipeline and Shader System](https://github.com/1PercentSync/himalaya/blob/main/9-pipeline-and-shader-system) — RHI pipeline abstraction
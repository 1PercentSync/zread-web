The **Path Tracing Reference View** provides a ground-truth rendering mode that uses Monte Carlo path tracing to accumulate physically accurate lighting. Unlike the real-time rasterization pipeline, this mode trades performance for accuracy—converging toward unbiased global illumination through progressive accumulation. The implementation leverages Vulkan Ray Tracing pipelines with a custom multi-lobe BRDF sampling strategy, multiple importance sampling (MIS) for environment lighting, and integration with Intel Open Image Denoise (OIDN) for rapid noise reduction.

## Architectural Overview

The reference view system spans three architectural layers: the **RHI** (Ray Tracing Pipeline), the **Render Pass** (ReferenceViewPass), and the **Shader Layer** (five RT shader stages). Understanding the data flow between these layers is essential for extending or debugging the path tracer.

```mermaid
flowchart TB
    subgraph CPU["CPU Layer"]
        RVP[ReferenceViewPass]
        RG[RenderGraph]
        DM[DescriptorManager]
    end
    
    subgraph GPU_Shaders["GPU Ray Tracing Pipeline"]
        RGEN[raygen<br/>reference_view.rgen]
        MISS[miss<br/>miss.rmiss]
        SMISS[shadow_miss<br/>shadow_miss.rmiss]
        CHIT[closesthit<br/>closesthit.rchit]
        AHIT[anyhit<br/>anyhit.rahit]
    end
    
    subgraph Resources["GPU Resources"]
        TLAS[TLAS<br/>Set 0 binding 4]
        ACCUM[Accumulation Buffer<br/>Set 3 binding 0]
        AUX[Albedo/Normal Aux<br/>Set 3 binding 1-2]
        SOBOL[Sobol Buffer<br/>Set 3 binding 3]
    end
    
    RVP -->|record()| RG
    RG -->|trace_rays| RGEN
    RGEN -->|traceRayEXT| TLAS
    TLAS -->|hit| CHIT
    TLAS -->|miss| MISS
    CHIT -->|shadow ray| SMISS
    TLAS -->|alpha test| AHIT
    CHIT -->|write| ACCUM
    CHIT -->|write| AUX
    RGEN -->|read| SOBOL
```

The architecture follows a **Mode A** design pattern where all shading computation occurs in the closest-hit shader, while the raygen shader manages the path tracing loop and accumulation logic. This separation keeps the bounce loop simple while centralizing BRDF evaluation and next-event estimation.

Sources: [reference_view_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/reference_view_pass.h#L1-L160), [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen#L1-L152)

## RT Pipeline Configuration

The path tracing pipeline consists of five shader stages organized into shader groups for the Shader Binding Table (SBT). The `RTPipelineDesc` structure defines this configuration with explicit separation between environment miss and shadow miss shaders.

| Shader Stage | File | Purpose | SBT Entry |
|-------------|------|---------|-----------|
| Ray Generation | `reference_view.rgen` | Primary ray generation, bounce loop, accumulation | Raygen (1 entry) |
| Closest Hit | `closesthit.rchit` | Surface shading, NEE, BRDF sampling | Hit Group (1 entry) |
| Any Hit | `anyhit.rahit` | Alpha mask and stochastic transparency | Hit Group (with CHIT) |
| Miss (Environment) | `miss.rmiss` | Environment cubemap sampling | Miss (entry 0) |
| Miss (Shadow) | `shadow_miss.rmiss` | Shadow ray visibility = 1 | Miss (entry 1) |

The SBT layout mirrors this organization: raygen region (1 entry), miss region (2 entries for environment and shadow), and hit region (1 entry combining closest-hit and any-hit). The `max_recursion_depth` is set to 1 because the implementation uses iterative path tracing in the raygen shader rather than recursive ray tracing.

Sources: [rt_pipeline.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/rt_pipeline.h#L1-L110), [reference_view_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/reference_view_pass.cpp#L98-L145)

## Path Tracing Loop (Raygen Shader)

The raygen shader implements an **iterative path tracing algorithm** with Russian Roulette termination. Each pixel executes one complete path per frame, accumulating results via a running average.

The primary ray generation uses inverse camera matrices from the global uniform buffer. Subpixel jitter via Sobol sampling provides anti-aliasing:

```glsl
// Subpixel jitter via Sobol dims 0-1
float jitter_x = rand_pt(0, pc.sample_count, pixel, pc.frame_seed, pc.blue_noise_index);
float jitter_y = rand_pt(1, pc.sample_count, pixel, pc.frame_seed, pc.blue_noise_index);

// Unproject to world-space ray
vec2 uv = (vec2(pixel) + vec2(jitter_x, jitter_y)) / vec2(size);
vec2 ndc = vec2(uv.x * 2.0 - 1.0, -(uv.y * 2.0 - 1.0));
```

The path tracing loop processes up to `max_bounces` iterations. For each bounce, it traces a ray through the TLAS and accumulates radiance weighted by path throughput. Russian Roulette activates at bounce ≥ 2, using the maximum throughput component as survival probability clamped to [0.05, 0.95].

The running average accumulation uses a simple incremental formula: `mix(old, new, 1/(n+1))`. When `sample_count == 0`, the shader overwrites the accumulation buffer; otherwise it blends with existing values.

Sources: [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen#L45-L125)

## Surface Shading (Closest-Hit Shader)

The closest-hit shader performs **full PBR shading** in a single stage, including vertex interpolation, normal mapping, material sampling, next-event estimation (NEE), and multi-lobe BRDF sampling for the next bounce.

**Vertex Interpolation**: The shader uses buffer references (`GL_EXT_buffer_reference`) to access vertex and index data directly from device addresses stored in `GeometryInfo`. Barycentric coordinates from `gl_HitAttributeEXT` interpolate position, normal, UVs, and tangent.

**Normal Mapping**: The shading normal combines the interpolated vertex normal with a tangent-space normal map. The `ensure_normal_consistency()` function prevents light leaks by reflecting the shading normal if it points below the geometric surface.

**Next-Event Estimation**: The shader evaluates two light sources:
1. **Directional lights** (delta distributions, MIS weight = 1)
2. **Environment map** (alias table importance sampling with power heuristic MIS)

Environment sampling uses a precomputed alias table for O(1) importance sampling proportional to luminance × sin(θ). The MIS weight balances between the light sampling PDF and the BRDF sampling PDF using the power heuristic.

**Multi-Lobe BRDF Sampling**: The shader selects between diffuse (cosine-weighted hemisphere) and specular (GGX VNDF) lobes based on Fresnel luminance. The selection probability `p_spec` clamps to [0.01, 0.99] to prevent zero-probability paths. The combined PDF for both lobes enables proper MIS weighting when the BRDF-sampled ray misses geometry and hits the environment.

Sources: [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L1-L314), [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L250-L320)

## Random Number Generation

The path tracer uses a **hybrid random number generator** combining Sobol quasi-random sequences with blue noise offsets for spatial decorrelation and golden-ratio scrambling for temporal variation.

**Sobol Sequence**: The 128-dimension Sobol direction number table (16 KB SSBO) provides low-discrepancy sampling. For dimensions ≥ 128, the system falls back to PCG hash. The sample index is cumulative per pixel across all accumulated frames.

**Cranley-Patterson Rotation**: Each dimension applies a per-pixel blue noise offset from a 128×128 texture. Spatial displacement by dimension (`dim * 73`, `dim * 127`) decorrelates samples across dimensions.

**Temporal Scrambling**: The frame seed advances each frame, adding golden-ratio fractional increments to the blue noise offset. This ensures uncorrelated sampling across time even with static camera.

The dimension allocation follows a fixed pattern: dimensions 0-1 for subpixel jitter, then 8 dimensions per bounce (lobe select, BRDF ξ0, BRDF ξ1, Russian Roulette, environment NEE r1-r4).

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L200-L260)

## Accumulation Management and Convergence

The `ReferenceViewPass` maintains CPU-side accumulation state that drives the running average. Key parameters include:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_bounces` | 8 | Maximum ray depth before forced termination |
| `max_clamp` | 10.0 | Firefly clamping threshold (0 = disabled) |
| `env_sampling` | true | Enable environment map importance sampling |
| `directional_lights` | false | Include directional lights in PT (disabled when env sampling active) |

Accumulation resets trigger on any change affecting lighting: camera transform, IBL rotation, light parameters, or PT settings. The `renderer_pt.cpp` compares current and previous frame values to detect changes automatically.

The convergence rate depends on scene complexity and lighting variance. Direct lighting with MIS converges faster than pure BRDF sampling. The firefly clamping threshold prevents high-variance samples (specular caustics, near-light surfaces) from dominating the running average.

Sources: [reference_view_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/reference_view_pass.h#L130-L150), [renderer_pt.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_pt.cpp#L45-L85)

## Alpha Testing and Stochastic Transparency

The any-hit shader handles non-opaque geometry through two alpha modes:

**Mask Mode** (`alpha_mode == 1`): Hard cutoff at `alpha_cutoff`. Texels below the threshold call `ignoreIntersectionEXT` to continue traversal.

**Blend Mode** (`alpha_mode == 2`): Stochastic alpha using PCG hash. The random value compares against the texel alpha; if greater, the intersection is ignored. This provides noise-free transparency at convergence while avoiding the cost of sorted transparency.

Opaque geometry never reaches the any-hit shader because the BLAS geometry flag `VK_GEOMETRY_OPAQUE_BIT_KHR` causes hardware to skip any-hit invocation entirely.

Sources: [anyhit.rahit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/anyhit.rahit#L1-L85)

## Denoiser Integration

The reference view integrates with Intel Open Image Denoise (OIDN) through auxiliary albedo and normal buffers written on bounce 0. The denoising pipeline operates asynchronously:

1. **Readback Pass**: Copies accumulation, albedo, and normal images to CPU-accessible buffers
2. **OIDN Processing**: Async denoising on separate threads
3. **Upload Pass**: Copies denoised result back to GPU texture
4. **Display**: Tonemapping uses denoised buffer when available

The `Denoiser` class manages the asynchronous workflow with state tracking (`Idle`, `ReadbackPending`, `Processing`, `UploadPending`). The renderer can display raw accumulation, denoised output, or trigger manual/automatic denoising at sample count intervals.

Sources: [renderer_pt.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_pt.cpp#L140-L220), [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L95-L105)

## Descriptor Set Layout

The path tracing pipeline uses four descriptor sets with Set 3 as a push descriptor updated per-pass:

**Set 0 (Global)**: View/projection matrices, lights, materials, instances, TLAS, geometry info, environment alias table
**Set 1 (Bindless)**: Texture2D array, CubeMap array  
**Set 2 (Render Targets)**: Intermediate textures (HDR color, depth, AO, etc.)
**Set 3 (Push Descriptor)**: Accumulation image, albedo aux, normal aux, Sobol buffer

The push descriptor design avoids descriptor pool management for per-frame varying resources. The `cmd.push_rt_descriptor_set()` call updates all four bindings atomically before `trace_rays`.

Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L205), [reference_view_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/reference_view_pass.cpp#L150-L220)

## Related Documentation

- For the underlying ray tracing pipeline infrastructure, see [Ray Tracing Infrastructure (AS, RT Pipeline)](https://github.com/1PercentSync/himalaya/blob/main/11-ray-tracing-infrastructure-as-rt-pipeline)
- For the render graph integration and resource management patterns, see [Render Graph System](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system)
- For the common BRDF functions and sampling utilities, see [Common Shader Library (BRDF, Bindings)](https://github.com/1PercentSync/himalaya/blob/main/27-common-shader-library-brdf-bindings)
- For the denoiser implementation details, see the framework layer documentation
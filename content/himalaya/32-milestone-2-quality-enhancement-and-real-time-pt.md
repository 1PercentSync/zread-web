Milestone 2 represents a **qualitative leap** in visual fidelity over Milestone 1, transforming the renderer from a "decent static scene viewer" into a production-quality real-time path tracing demonstration. This milestone builds upon the RT infrastructure established in [Milestone 1 — Static Scene Rendering](https://github.com/1PercentSync/himalaya/blob/main/31-milestone-1-static-scene-rendering) and introduces screen-space effects, advanced ambient occlusion, and a complete real-time path tracing mode with asynchronous denoising.

Sources: [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L1-L76), [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L1-L105)

## Overview and Goals

The primary objective of Milestone 2 is to harvest all "low-hanging fruit" for visual quality improvement while establishing the foundation for real-time path tracing. The milestone is divided into three major workstreams: **rasterization enhancements**, **real-time path tracing mode**, and **hybrid RT effects**. Upon completion, the rasterization mode features dynamic sky with atmospheric scattering, screen-space reflections, and high-quality ambient occlusion. The PT mode delivers real-time path tracing comparable to modern game engines like DOOM: The Dark Ages, using ReSTIR DI, SHaRC, and NRD denoising.

Sources: [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L1-L20)

## Visual Quality Improvements (Rasterization Mode)

### Ground-Truth Ambient Occlusion (GTAO)

The GTAO implementation replaces basic SSAO with a structured horizon-search algorithm that produces physically-based diffuse occlusion. The technique uses cosine-weighted analytic integration following Jimenez et al.'s 2016 paper, computing both occlusion and bent normals for more realistic indirect lighting response.

The implementation follows a three-pass pipeline: **GTAO Pass** performs the horizon search with temporal jitter for noise distribution, **AO Spatial Pass** applies a 5x5 edge-aware bilateral blur using depth-based edge weights to prevent bleeding across geometry boundaries, and **AO Temporal Pass** blends current-frame results with reprojected history using three-layer rejection (UV validity, depth consistency, and neighborhood clamping).

Sources: [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L1-L177), [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L1-L200), [ao_spatial.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_spatial.comp#L1-L158), [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L1-L182)

### Screen-Space Contact Shadows

Contact shadows provide high-resolution shadow detail near contact points where CSM cascade resolution is insufficient. The implementation ray-marches in clip space toward the primary directional light, using interleaved gradient noise for temporal jitter that converts banding into resolvable noise. The shader includes adaptive step count based on screen-space ray length, dynamic depth tolerance, and slope-scaled bias to prevent self-intersection artifacts.

Sources: [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L1-L168), [contact_shadows.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/contact_shadows.comp#L1-L200)

### Additional Low-Cost Enhancements

Several minimal-effort improvements deliver significant visual impact: **Burley Diffuse** replaces Lambertian response for better rough surface appearance at grazing angles, **Film Grain** masks banding artifacts in smooth gradients, **Chromatic Aberration** adds cinematic lens character, and **Multi-Directional-Light CSM** extends the single light limitation to support N directional lights with independent cascade data.

Sources: [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L30-L45)

## Real-Time Path Tracing Mode

The PT mode leverages the RT infrastructure from Milestone 1 to provide a complete path tracing reference implementation with progressive accumulation and viewport denoising.

### Reference View Pass Architecture

The **ReferenceViewPass** serves as the core PT rendering pass, dispatching an RT pipeline that traces one sample per pixel per frame. The implementation uses a running-average accumulation buffer (RGBA32F) where each frame blends new samples with previous results using weight `1/(n+1)`. When the camera is static, samples accumulate indefinitely, converging to a noise-free reference image.

The raygen shader (`reference_view.rgen`) handles primary ray generation with subpixel jitter via Sobol sequences, the bounce loop with Russian Roulette termination starting at bounce 2, firefly clamping for indirect bounces to prevent energy spikes, and environment map importance sampling with MIS weights.

Sources: [reference_view_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/reference_view_pass.cpp#L1-L200), [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen#L1-L152), [reference_view_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/reference_view_pass.h#L1-L160)

### Closest-Hit Shading

The **closesthit.rchit** shader performs all surface shading in a single stage, following a "Mode A" architecture where raygen only accumulates results. It handles vertex interpolation via buffer references, normal mapping with consistency correction against the geometric normal, multi-lobe BRDF sampling (diffuse + specular based on Fresnel-weighted probability), Next Event Estimation (NEE) for directional lights with shadow rays, and environment light sampling via alias table importance sampling with MIS.

The shader also writes OIDN auxiliary data (albedo + normal) on bounce 0 for denoising quality.

Sources: [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L1-L200), [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L1-L200)

### Asynchronous OIDN Denoising

The **Denoiser** class provides zero-main-thread-blocking denoising using Intel Open Image Denoise (OIDN). The workflow follows a state machine: **Idle** → request_denoise() → **ReadbackPending** → GPU readback copy → launch_processing() → **Processing** (background thread) → **UploadPending** → GPU upload copy → complete_upload() → **Idle**.

The implementation uses timeline semaphores for GPU→CPU synchronization, persistent staging buffers for data transfer, and automatic device selection (GPU preferred, CPU fallback). The denoiser supports both automatic interval-based triggering and manual capture, with generation tracking to discard stale results when the camera moves.

Sources: [denoiser.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/denoiser.cpp#L1-L200), [denoiser.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/denoiser.h#L1-L200), [renderer_pt.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_pt.cpp#L1-L200)

### Path Tracing Render Path

The **render_path_tracing** function in `renderer_pt.cpp` orchestrates the PT pipeline: accumulation buffer management with dirty detection for reset conditions, denoise trigger logic with configurable intervals, readback/upload pass registration conditional on denoiser state, and final composition through the tonemapping pass.

The implementation handles accumulation reset on any view or lighting change, target sample count with automatic completion timing, and seamless switching between raw accumulation and denoised output.

Sources: [renderer_pt.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_pt.cpp#L1-L316)

## Scene Acceleration Structure Builder

The **SceneASBuilder** constructs the BLAS/TLAS hierarchy required for ray tracing. It groups meshes by `group_id` into multi-geometry BLAS (one BLAS per unique source mesh), deduplicates TLAS instances by `(group_id, transform)` pairs to reduce memory, and builds a Geometry Info SSBO mapping geometry indices to vertex/index buffer addresses and material offsets.

The builder respects material alpha mode for opacity flags (opaque meshes skip any-hit shader invocation), and handles degenerate primitive filtering.

Sources: [scene_as_builder.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/scene_as_builder.cpp#L1-L200)

## Shader Infrastructure

### Path Tracing Common Library

The **pt_common.glsl** header provides shared utilities for all RT shaders: ray payload definitions (`PrimaryPayload`, `ShadowPayload`), buffer reference types for vertex/index access, hit attribute interpolation with barycentric coordinates, ray origin offset using Wächter & Binder's method for robust self-intersection avoidance, normal consistency correction to prevent light leaks, and multi-lobe BRDF selection based on Fresnel luminance.

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L1-L200)

### Sobol Sampling

The renderer uses Sobol low-discrepancy sequences for quasi-Monte Carlo integration. The Sobol direction numbers are stored in a 128-dimension × 32-bit SSBO (16 KB), with dimension allocation: 0-1 for subpixel jitter, and 8 dimensions per bounce for lobe selection, BRDF sampling, Russian Roulette, and environment NEE.

Sources: [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen#L30-L45)

## Integration with Render Graph

All passes integrate with the **RenderGraph** system from Milestone 1, declaring resource usage through `RGResourceUsage` structures. The PT passes use `ReadWrite` access for accumulation (supporting both `imageLoad` and `imageStore`), while auxiliary passes use appropriate read/write declarations for their inputs and outputs.

Sources: [reference_view_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/reference_view_pass.cpp#L200-L345)

## Relationship to Other Milestones

Milestone 2 builds directly upon the RT infrastructure established in [Milestone 1 — Static Scene Rendering](https://github.com/1PercentSync/himalaya/blob/main/31-milestone-1-static-scene-rendering), particularly the acceleration structure management and RT pipeline abstraction. The screen-space effects (GTAO, contact shadows) share infrastructure with the [Depth PrePass and Forward Rendering](https://github.com/1PercentSync/himalaya/blob/main/18-depth-prepass-and-forward-rendering) system.

Looking forward, [Milestone 3 — Dynamic Objects and Performance](https://github.com/1PercentSync/himalaya/blob/main/33-milestone-3-dynamic-objects-and-performance) will extend the PT mode with dynamic object support, ReSTIR GI for real-time indirect lighting, and full NRD integration. The hybrid RT effects planned for M2 (RT reflections, RT shadows) provide a bridge between rasterization and full path tracing.

Sources: [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L60-L76)

## Summary

Milestone 2 transforms the Himalaya renderer from a capable static scene viewer into a production-quality real-time path tracing demonstration. The key achievements include: a complete three-pass GTAO system with temporal filtering, screen-space contact shadows for high-frequency shadow detail, a full path tracing mode with progressive accumulation and MIS-weighted sampling, asynchronous OIDN denoising with zero main-thread blocking, and robust scene acceleration structure building with material-aware opacity handling.

These capabilities establish the foundation for the dynamic object support and advanced lighting algorithms planned in Milestone 3.
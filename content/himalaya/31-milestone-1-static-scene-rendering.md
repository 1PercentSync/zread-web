Milestone 1 establishes the foundational rendering pipeline for Himalaya, delivering a photorealistic static scene viewer with free camera movement. This milestone focuses on indoor and outdoor environments with baked indirect lighting, cascaded shadow mapping, and a complete PBR material system. The architecture balances immediate visual quality with a clear evolution path toward dynamic lighting and real-time effects in future milestones.

## What Milestone 1 Delivers

Milestone 1 transforms raw Vulkan primitives into a cohesive rendering system capable of producing visually compelling static scenes. The core philosophy is **visible progress at every stage** — no infrastructure work proceeds without demonstrable output. This milestone produces three distinct rendering modes: a full rasterization pipeline for real-time exploration, a path-traced reference view for ground-truth comparison, and an offline baking mode for generating lightmaps and reflection probes.

The rasterization pipeline implements Forward+ rendering with MSAA anti-aliasing, delivering PBR materials with metallic-roughness workflow, image-based lighting from HDR environments, and comprehensive shadow coverage through cascaded shadow maps with percentage-closer filtering. Screen-space ambient occlusion (GTAO) adds contact shadowing between objects, while contact shadows provide fine-grained grounding at object edges. The post-processing chain completes the visual pipeline with bloom, auto-exposure, ACES tonemapping, and color grading.

The path-traced reference view provides an alternative rendering mode using Vulkan Ray Tracing extensions. When activated, the entire rasterization pipeline yields to a compute-intensive but physically accurate path tracer that accumulates samples over time, producing noise-free reference images when the camera remains stationary. This mode validates the ray tracing infrastructure while giving artists a ground-truth comparison for the real-time renderer.

Sources: [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L1-L105), [m1-development-order.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-development-order.md#L1-L50)

## Ten Development Phases

Milestone 1 progresses through ten distinct phases, each producing verifiable output before advancing. This phased approach ensures architectural decisions prove their value in practice before building upon them.

**Phase 1: Minimum Visible Triangle** establishes the Vulkan foundation — instance creation, device selection with queue families, swapchain management, VMA integration, and shader runtime compilation. The deliverable is a hardcoded triangle rendered to screen, validating that the entire graphics stack functions correctly.

**Phase 2: Basic Rendering Pipeline** introduces the bindless descriptor system, mesh loading via fastgltf, texture loading with mip generation, and the material system foundation. The camera controller enables free scene exploration. The Render Graph system makes its first appearance with barrier automation. By phase end, a loaded glTF scene renders with basic lighting through ImGui-adjustable parameters.

**Phase 3: PBR Lighting Foundation** implements the core lighting equation — Lambert diffuse plus Cook-Torrance specular with GGX distribution, Smith height-correlated visibility, and Schlick Fresnel. Image-based lighting arrives through split-sum approximation with precomputed BRDF integration LUTs. Depth and normal prepasses enable subsequent screen-space effects. The deliverable shows metal surfaces reflecting the sky environment with proper energy conservation.

**Phase 4: Shadows** brings cascaded shadow maps with four cascades covering near-to-far distances, PCF soft shadow filtering, cascade blending at split boundaries, and dual bias compensation (slope-scaled plus normal offset). Alpha-masked shadows handle cutout materials. Instancing reduces per-draw overhead from 72 bytes of push constants to 4 bytes. The visual result adds crucial depth cues through dynamic shadows.

**Phase 5: Screen-Space Effects** implements GTAO for ambient occlusion with bent normal output, spatial bilateral filtering, and temporal accumulation for stability. Contact shadows add fine detail at object contact points. This phase establishes the temporal filtering infrastructure that Milestone 2's SSR and SSGI will reuse directly.

**Phase 6: Ray Tracing Infrastructure** introduces Vulkan RT extensions, BLAS/TLAS acceleration structures, and the RT pipeline abstraction. The path-traced reference view provides the first ray-traced output with accumulation, OIDN denoising, and ImGui parameter control. This validates the entire RT stack for subsequent baking work.

**Phase 7: PT Baker** implements the GPU path tracing baker for lightmaps and reflection probes using xatlas for UV2 generation. The baker runs asynchronously, displaying progress while accumulating samples, then denoises and compresses to BC6H for KTX2 storage.

**Phase 8: Indirect Lighting Integration** loads baked lightmaps and reflection probes into the rasterization pipeline. Indoor scenes gain soft bounce lighting from windows, while reflective surfaces show parallax-corrected cubemap reflections rather than just sky reflections.

**Phase 9: Transparency** adds sorted transparent rendering with alpha blending and screen-space refraction sampling from the HDR buffer.

**Phase 10: Post-Processing Chain** completes the pipeline with auto-exposure through luminance histogram reduction, bloom via downsample-upsample chains, height fog, vignette, and color grading.

Sources: [m1-development-order.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-development-order.md#L1-L204)

## Architecture Overview

The rendering system organizes into four layers with strict dependency direction. Layer 0 (RHI) abstracts Vulkan primitives into handles and commands. Layer 1 (Framework) provides scene management, render graph orchestration, and shared algorithms. Layer 2 (Passes) implements individual rendering techniques as self-contained modules. Layer 3 (Application) coordinates the window, input, and renderer selection.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Application                                           │
│  ├── Application (main loop, window management)                 │
│  ├── Renderer (render path dispatch, GPU data fill)             │
│  ├── SceneLoader (glTF → render list)                           │
│  ├── CameraController (free roam)                               │
│  └── DebugUI (ImGui panels, parameter adjustment)               │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Render Passes                                         │
│  ├── DepthPrePass (depth + normal output)                       │
│  ├── ShadowPass (CSM cascade rendering)                         │
│  ├── GTAO/ContactShadows (screen-space effects)                 │
│  ├── ForwardPass (main lighting)                                │
│  ├── ReferenceViewPass (path-traced reference)                  │
│  ├── BakerPasses (lightmap/probe baking)                        │
│  └── PostProcess (bloom, tonemapping, color grading)            │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: Framework                                             │
│  ├── RenderGraph (barrier automation, resource management)      │
│  ├── MaterialSystem (PBR parameter layout)                      │
│  ├── SceneASBuilder (acceleration structure construction)       │
│  ├── IBL (environment map processing)                           │
│  └── Culling (frustum culling)                                  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 0: RHI                                                   │
│  ├── Context (instance, device, queues, VMA)                    │
│  ├── ResourceManager (buffers, images, samplers)                │
│  ├── DescriptorManager (bindless sets, per-frame descriptors)   │
│  ├── Pipeline (graphics/compute pipeline creation)              │
│  ├── RTPipeline (ray tracing pipeline + SBT)                    │
│  ├── AccelerationStructure (BLAS/TLAS management)               │
│  └── CommandBuffer (recording wrappers)                         │
└─────────────────────────────────────────────────────────────────┘
```

The Render Graph sits at the heart of Layer 1, orchestrating the frame flow. Unlike fully automatic render graph systems, Himalaya's implementation requires manual pass registration while automating barrier insertion between passes. This design trades some convenience for explicit control and predictable behavior.

Sources: [m1-interfaces.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-interfaces.md#L1-L100), [m1-design-decisions-core.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-design-decisions-core.md#L1-L50)

## Frame Flow and Data Flow

A complete rasterization frame follows a fixed execution order through the Render Graph. Each pass declares its resource dependencies, allowing the graph to compute and insert appropriate Vulkan barriers.

The frame begins with CPU-side culling — frustum culling against the camera produces visible object lists for opaque and transparent geometry, with transparent objects sorted back-to-front by distance. Shadow rendering follows, with the CSM Shadow Pass rendering each cascade to a layer of a 2D array texture. The depth and normal prepass outputs multi-sampled buffers that resolve to single-sample versions for screen-space effects.

Screen-space effects execute as compute passes reading the resolved depth and normal buffers. GTAO and Contact Shadows have no data dependency between them, so the Render Graph schedules them concurrently. The AO result undergoes spatial bilateral filtering followed by temporal accumulation against history.

The Forward Lighting Pass performs the main shading work, reading shadow maps, AO, contact shadows, lightmaps, and reflection probes to compute final radiance into an HDR color buffer. Transparent objects render afterward with access to the HDR buffer for refraction sampling. MSAA resolve produces a single-sample HDR buffer that feeds the skybox pass (filling background pixels) and the post-processing chain.

The post-processing sequence runs: height fog blends atmospheric scattering, auto-exposure computes scene luminance, bloom extracts and blurs bright regions, tonemapping compresses HDR to LDR with ACES curve fitting, vignette darkens corners, and color grading applies final stylistic adjustments before presentation.

Sources: [m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L1-L100)

## Descriptor Architecture

The binding system uses a three-tier descriptor set layout that remains consistent across graphics, compute, and ray tracing pipelines.

**Set 0** contains global frame data: the GlobalUBO with view/projection matrices and rendering parameters, the LightBuffer with directional light data, the MaterialBuffer with PBR parameters for all materials, and the InstanceBuffer with per-instance transforms. Set 0 also holds the TLAS and Geometry Info SSBO for ray tracing. This set updates per frame with double buffering for frames in flight.

**Set 1** provides bindless texture access through partially-bound descriptor arrays. Binding 0 contains up to 4096 2D textures for material maps; binding 1 contains up to 256 cubemaps for IBL and skybox. Texture indices pass through material structures, with invalid indices resolving to default white/black/normal textures.

**Set 2** carries frame-specific render targets: HDR color, resolved depth, resolved normal, AO texture, contact shadow mask, and shadow map arrays. This set also uses per-frame double buffering to support temporal effects.

Compute and ray tracing pipelines add **Set 3** as a push descriptor for output images, enabling flexible compute dispatch without descriptor pool management.

Sources: [m1-design-decisions-core.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-design-decisions-core.md#L100-L150)

## Resource Management Patterns

Resources follow explicit lifecycle management rather than RAII. All Vulkan objects provide `destroy()` methods called at predictable points — typically during renderer shutdown, resize handling, or scene unloading. This explicit approach handles Vulkan's strict destruction ordering requirements where dependencies must be destroyed before objects they reference.

Images and buffers use generation-based handles combining an index into a resource pool with a generation counter. When a resource releases, its slot increments the generation. Subsequent access with an old handle detects the mismatch and reports use-after-free. Pipeline objects remain outside this system — passes hold them directly with clear single ownership.

The Render Graph manages transient resources through "managed images" that automatically resize with the viewport and handle format changes. Temporal resources allocate double buffers that swap each frame, supporting reprojection-based temporal filtering. The graph tracks resource state across passes, inserting image layout transitions and memory barriers based on declared usage patterns.

Sources: [m1-design-decisions-core.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-design-decisions-core.md#L50-L100), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L100)

## Ray Tracing Integration

Ray tracing capabilities extend the base architecture without disrupting existing paths. The system detects RT support at device selection time, preferring RT-capable hardware but falling back to pure rasterization when unavailable. When RT is available, the descriptor system expands with TLAS and geometry info bindings; when unavailable, these bindings remain absent and RT-dependent features hide from the UI.

The Scene AS Builder constructs acceleration structures from loaded scene data. Each unique mesh group becomes a BLAS with multiple geometries for its primitives. TLAS instances reference these BLAS with transform matrices, enabling efficient ray-scene intersection. The builder also constructs a Geometry Info buffer mapping each geometry to its vertex/index buffer addresses and material parameters.

Three independent render paths coexist: the full rasterization pipeline for real-time exploration, the path-traced reference view for quality validation, and the baking mode for offline content generation. Each path owns its frame flow, with the Renderer dispatching to the appropriate implementation based on user selection.

Sources: [m1-rt-decisions.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-rt-decisions.md#L1-L100), [current-phase.md](https://github.com/1PercentSync/himalaya/blob/main/docs/current-phase.md#L1-L100)

## Key Technical Decisions

Several architectural choices shape Milestone 1's implementation:

**Reverse-Z depth buffering** uses D32Sfloat format with near=1, far=0, clear=0, and GREATER comparison. This distribution provides uniform precision across the view frustum, eliminating depth fighting artifacts common with standard depth configurations.

**MSAA resolve strategy** performs depth and normal resolve before screen-space effects, operating on single-sample buffers. While this loses sub-pixel information, the low-frequency nature of AO and the blur from temporal filtering make the loss visually imperceptible. The alternative — operating directly on MSAA buffers — would require significantly more complex sampling code.

**Render Graph per-frame rebuild** reconstructs the entire graph each frame rather than maintaining persistent structures. This approach simplifies dynamic resource management and pass conditionalization at the cost of CPU overhead that remains negligible for the target scene complexity.

**Shader hot-reload** compiles GLSL to SPIR-V at runtime using shaderc, with disk caching for subsequent launches. This enables rapid iteration on shader code without application restart.

**BC texture compression** runs at load time for uncached textures, with results persisted as KTX2 files. This trades initial load time for reduced runtime memory and bandwidth without requiring offline asset preprocessing pipelines.

Sources: [m1-design-decisions-core.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-design-decisions-core.md#L1-L50)

## Limitations and Future Work

Milestone 1 intentionally defers several features to subsequent milestones:

| Limitation | Resolution Target |
|------------|-------------------|
| Inaccurate reflections (probe-based only) | Milestone 2 (SSR) |
| Fixed soft shadow width | Milestone 2 (PCSS) |
| No dynamic indirect lighting | Milestone 2 (SSGI) |
| Static sky only | Milestone 2 (Bruneton atmospheric model) |
| No volumetric effects | Milestone 2 (God Rays) / Milestone 3 (Froxel) |
| MSAA-only anti-aliasing | Milestone 2 (FSR SDK integration) |
| Single directional light with shadows | Milestone 2 (multi-light shadow maps) |
| No dynamic object shadows | Milestone 3 |

These limitations reflect deliberate scope boundaries rather than technical blockers. The architecture preserves extension points for each deferred feature — the temporal filtering infrastructure supports SSR/SSGI, the shadow system generalizes to multiple lights, and the RT infrastructure enables real-time path tracing evolution.

Sources: [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L20-L50)

## Next Steps

After completing Milestone 1, the project advances to [Milestone 2 — Quality Enhancement and Real-Time PT](https://github.com/1PercentSync/himalaya/blob/main/32-milestone-2-quality-enhancement-and-real-time-pt). Milestone 2 introduces screen-space reflections for accurate glossy surfaces, screen-space global illumination for dynamic color bleeding, percentage-closer soft shadows for distance-aware penumbra, and the foundation for real-time path tracing with denoising. The architectural investments from Milestone 1 — particularly the Render Graph, temporal filtering infrastructure, and RT pipeline abstraction — enable these enhancements without fundamental restructuring.

For deeper understanding of specific subsystems, consult the Layer 0 through Layer 3 documentation in the Deep Dive section of the catalog. The [Frame Flow and Render Graph Design](https://github.com/1PercentSync/himalaya/blob/main/34-frame-flow-and-render-graph-design) page provides additional detail on barrier computation and resource lifetime management.
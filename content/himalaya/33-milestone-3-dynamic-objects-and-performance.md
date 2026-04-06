Milestone 3 represents the third major evolution phase of the Himalaya renderer, building upon the solid foundations established in [Milestone 1 — Static Scene Rendering](https://github.com/1PercentSync/himalaya/blob/main/31-milestone-1-static-scene-rendering) and the visual quality enhancements from [Milestone 2 — Quality Enhancement and Real-Time PT](https://github.com/1PercentSync/himalaya/blob/main/32-milestone-2-quality-enhancement-and-real-time-pt). While M1 established the core rendering infrastructure and M2 focused on visual fidelity through path tracing and screen-space effects, M3 introduces **dynamic object support**, **performance optimizations for larger scenes**, and **advanced lighting workflows** that bridge the gap between static and interactive worlds.

The architectural philosophy guiding M3 maintains the renderer's four-layer design: the RHI layer provides Vulkan abstraction, the Framework layer offers scene management and resource handling, the Passes layer implements specific rendering techniques, and the Application layer orchestrates everything. This milestone extends each layer with capabilities essential for production scenarios—moving beyond static architectural visualization toward interactive environments with animated elements, complex lighting, and scalable performance.

Sources: [milestone-3.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-3.md#L1-L58)

## Dynamic Objects Support

Dynamic objects—meshes that move, rotate, or scale between frames—require fundamental changes to how the renderer tracks geometry and manages temporal data. Unlike the static scenes of M1, dynamic objects need per-frame transform updates, motion vector generation, and proper indirect lighting integration.

### Motion Vectors and Temporal Stability

The foundation for all temporal effects lies in **per-object motion vectors**. In the static scenes of M1 and M2, only camera motion needed consideration for effects like TAA (Temporal Anti-Aliasing) and upscalers. With dynamic objects, each mesh instance must track both its current and previous frame transform to compute accurate motion vectors.

The `MeshInstance` structure in the scene data system already reserves space for this through its `prev_transform` field, which stores the previous frame's transformation matrix. During each frame update, the application layer copies `transform` to `prev_transform` before applying new animation or physics updates. This historical data enables the renderer to compute motion vectors in shaders by comparing world positions across frames, essential for temporal accumulation passes and upscaler integration.

The `GlobalUniformData` structure carries the `prev_view_projection` matrix specifically for this purpose—transforming current-frame world positions into previous-frame screen-space coordinates to derive motion vectors. This infrastructure, established in M1 Phase 5, becomes fully utilized in M3 when dynamic objects enter the scene.

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L71-L82), [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L227-L234)

### Per-Object Motion Blur

Camera motion blur—implemented in M2 based solely on camera movement—gets upgraded to **per-object motion blur** in M3. This effect applies independent blur to moving objects regardless of camera state, creating more convincing motion representation. The implementation requires velocity buffers populated during the depth prepass or forward pass, where each pixel stores the screen-space motion vector derived from the instance's `prev_transform`.

The motion blur pass samples these velocity buffers during post-processing, applying directional blur proportional to the velocity magnitude. This creates streaking effects on fast-moving objects while keeping the background sharp when the camera is stationary—a significant visual improvement over pure camera motion blur.

### Light Probes for Dynamic Objects

Static lightmaps baked in M1 provide beautiful indirect illumination for static geometry, but dynamic objects moving through the scene need a different approach. **Light probes**—sample points throughout the scene that capture incident lighting—provide the solution. The implementation samples from the existing lightmap data at probe positions, allowing dynamic objects to receive environment-appropriate indirect lighting as they move.

The probe system places sample points in a regular grid or adaptive distribution throughout the scene bounds. Each probe stores spherical harmonic coefficients or irradiance values sampled from the lightmap. Dynamic objects query the nearest probes and interpolate based on their position, maintaining visual consistency with the baked lighting while supporting free movement.

## Visual Quality Enhancements

M3 addresses several visual gaps that become apparent in production scenes, particularly around interior lighting, material accuracy, and artistic control.

### Local Light Shadows with Caching

Point lights and spotlights—added in M2 for direct illumination—gain **shadow casting capabilities** in M3. Unlike the single directional light with CSM (Cascaded Shadow Maps) from M1, local lights require different shadow representations. Point lights use cubemap shadow maps (six faces covering all directions), while spotlights use single 2D shadow maps.

The critical optimization is **static light caching**: lights that don't move and don't have dynamic occluders in their influence radius can have their shadow maps baked once and reused. The system tracks light transform stability and dynamic object proximity to determine when shadow recalculation is necessary. This hybrid approach provides accurate shadows from lamps and fixtures without the prohibitive cost of re-rendering shadow maps every frame.

### Froxel Volumetric Fog

Replacing the screen-space god rays from M2, **Froxel Volumetric Fog** provides true volumetric lighting simulation. The scene volume gets divided into a 3D grid of froxels (voxel-like cells), and light scattering is computed per-froxel considering shadow information from all light sources.

This technique produces convincing light shafts (god rays), atmospheric haze, and localized fog volumes that properly interact with shadows. When combined with the point light shadows, interior scenes gain dramatic depth through visible light cones from windows and fixtures. The froxel data is typically computed at quarter resolution and upsampled with temporal filtering for performance.

### Multiscatter GGX

High-roughness metallic surfaces in standard PBR appear artificially dark due to the single-scattering assumption in the GGX BRDF. **Multiscatter GGX** corrects this by accounting for multiple microfacet bounces within the BRDF evaluation. The implementation uses a precomputed LUT (Look-Up Texture) indexed by roughness and viewing angle, requiring only a texture sample and minor shader modifications.

This improvement is particularly noticeable on rough metals like weathered steel or oxidized copper, which now maintain proper energy conservation across all roughness values. The infrastructure for this was established in M2's IBL system, where the BRDF LUT already handles similar precomputed integration.

### Khronos PBR Neutral Tonemapping

The default ACES tonemapping—while cinematic—can significantly alter material appearance, making PBR values look different in the final image than in the authoring tools. **Khronos PBR Neutral tonemapping** provides an alternative that preserves material albedo more faithfully, ensuring that a 0.5 gray surface appears as middle gray in the final output.

This becomes especially important when matching reference photographs or when artists need predictable material behavior. The tonemapping implementation replaces the ACES curve in the tonemapping pass with the PBR Neutral formulation, controlled via a configuration flag for easy comparison.

### Multiple Shading Models

M3 introduces support for **multiple shading models** beyond standard PBR, specifically enabling stylized toon/cel shading for scene elements. This requires the material system to support multiple pipeline variants—different shader permutations selected based on material template.

The `MaterialInstance` structure already contains a `template_id` field for this purpose, and the `GPUMaterialData` layout accommodates template-specific parameters. Forward+ rendering naturally supports this through pipeline state objects: opaque objects with different shading models simply bind different pipelines during the forward pass. This infrastructure enables scenes mixing photorealistic and stylized elements, common in architectural visualization and game environments.

Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L47-L58), [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L77-L85)

## Performance and Scalability

As scenes grow beyond the architectural visualization scale of M1, performance optimizations become critical. M3 introduces several techniques to handle larger object counts, more light sources, and greater view distances.

### Clustered Forward Shading

M2's tiled forward shading divides the screen into 2D tiles and assigns lights per-tile. **Clustered Forward** extends this into three dimensions by also subdividing along the depth axis, creating a 3D grid of clusters. Each cluster stores only the lights that affect its volume, dramatically reducing the light evaluation cost for scenes with many localized light sources.

The clustering pass runs on compute shaders, building a light assignment structure that the forward pass consumes. This becomes essential when combining point lights with shadow casting—the per-pixel light count must be strictly bounded for performance, and 3D clustering provides tighter bounds than 2D tiling for depth-varying light distributions.

### Hardware Occlusion Query

**Hardware Occlusion Queries** provide conservative occlusion culling using the GPU's depth testing hardware. The implementation uses a two-pass approach: first, a simplified depth prepass renders coarse bounding geometry; second, occlusion queries test detailed objects against this depth buffer before committing to full rendering.

This technique particularly benefits interior scenes with multiple rooms or complex architectural elements where entire sections may be hidden behind walls. The queries are conservative—false positives (rendering occluded objects) are acceptable, but false negatives (culling visible objects) must be avoided. The existing depth prepass infrastructure from M1 provides the foundation for this optimization.

### Discrete LOD with Dithered Cross-Fade

**Level of Detail (LOD)** reduces geometric complexity for distant objects. The scene contains multiple versions of each mesh at different triangle counts, and the renderer selects the appropriate version based on distance and screen-space size. **Dithered cross-fading** provides smooth transitions between LOD levels using a noise pattern to gradually blend between high and low detail representations, avoiding the popping artifacts of hard switches.

The mesh system tracks which LOD level is active per-instance, and the forward pass applies dithering based on the interpolation factor between levels. This allows aggressive LOD strategies—dropping to very low detail at moderate distances—without distracting visual artifacts.

### Shadow Atlas Management

With multiple shadow-casting lights, individual shadow map allocations become fragmented and inefficient. The **Shadow Atlas** consolidates all shadow maps into a single large texture atlas, with regions dynamically allocated based on light importance and distance.

The atlas manager assigns resolution based on:
- Light intensity and screen-space coverage
- Distance from camera
- Temporal stability (recently updated shadows may get higher resolution)

Static cached shadows occupy fixed atlas regions, while dynamic shadows use a ring buffer of atlas slots. This unified management prevents the memory fragmentation and binding overhead of individual shadow map textures.

## Path Tracing Indirect Light Upgrade

The path tracing mode introduced in M2 receives a significant quality upgrade in M3 through **ReSTIR GI** (Reservoir-based Spatio-Temporal Importance Resampling for Global Illumination), replacing the SHaRC (Spatial Hash Radiance Cache) system.

### ReSTIR GI Architecture

While SHaRC provided indirect lighting through a spatial hash grid with relatively low frequency updates, ReSTIR GI achieves pixel-precise indirect lighting through reservoir-based path resampling. The algorithm maintains reservoirs—compact representations of candidate light paths—at each pixel, then spatially and temporally resamples these reservoirs to share high-quality path discoveries across the image.

The implementation builds upon the ReSTIR DI (Direct Illumination) system from M2, sharing the reservoir data structures and sampling infrastructure. Key components include:
- **Initial candidate sampling**: Generate candidate indirect paths via BSDF sampling
- **Reservoir update**: Combine new candidates with historical reservoirs using weighted reservoir sampling
- **Spatial resampling**: Share reservoirs with neighboring pixels to amplify effective sample count
- **Temporal resampling**: Reuse and reweight reservoirs from previous frames

The result is indirect lighting quality approaching Cyberpunk 2077's RT Overdrive mode, with accurate color bleeding, precise contact shadows from indirect occlusion, and stable temporal accumulation.

### Integration with Existing RT Infrastructure

The ReSTIR GI implementation leverages the RT infrastructure established in M1: the `SceneASBuilder` provides acceleration structure management, the `RTPipeline` abstraction handles shader binding tables, and the `ReferenceViewPass` serves as the integration point. The `GPUGeometryInfo` structure continues to provide per-geometry vertex and index buffer addresses for ray intersection.

The shader integration extends `pt_common.glsl` with ReSTIR-specific reservoir operations and BSDF evaluation functions, while the ray generation shader in `reference_view.rgen` orchestrates the path sampling and reservoir management.

Sources: [scene_as_builder.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_as_builder.h#L1-L66), [rt_pipeline.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/rt_pipeline.h#L1-L108), [reference_view_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/reference_view_pass.h#L1-L130)

## Render Graph Evolution

The Render Graph system from M1 continues to serve as the backbone of frame orchestration, with M3 features integrating seamlessly into the existing pass architecture. The `RenderGraph` class manages temporal resources through its managed image API, which becomes essential for motion vector buffers, TAA history, and ReSTIR reservoir buffers.

Temporal resources use the double-buffering mechanism: `create_managed_image()` with `temporal=true` allocates current and history backing images, `use_managed_image()` imports the current frame's version, and `get_history_image()` provides access to previous frame data. The `is_history_valid()` query allows passes to handle first-frame or post-resize scenarios gracefully.

The pass registration pattern remains unchanged—each M3 pass (motion blur, volumetric fog, clustered light assignment) declares its resource inputs and outputs via `RGResourceUsage` structures, and the graph automatically computes layout transitions and synchronization barriers.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L313)

## Implementation Priorities

M3's broad scope allows flexible prioritization based on project needs:

| Priority Scenario | Recommended Focus |
|-------------------|-------------------|
| Character/Animation Showcase | Dynamic objects support → Motion vectors → Per-object motion blur → Light probes |
| Large Open World | LOD system → Occlusion queries → Clustered forward → Shadow atlas |
| Interior/Atmospheric Scenes | Point light shadows → Froxel fog → Volumetric effects → Multiscatter GGX |

The modular pass architecture enables this flexibility—each feature can be developed and enabled independently without disrupting existing functionality.

## Relationship to Architecture

M3's features respect the four-layer architectural boundaries established in the project:

- **Layer 0 (RHI)**: Extended with buffer device address support for dynamic object transforms, occlusion query primitives
- **Layer 1 (Framework)**: Scene data structures gain motion vector support; Render Graph manages temporal resources
- **Layer 2 (Passes)**: New passes for motion blur, volumetric fog, clustered shading, ReSTIR GI
- **Layer 3 (Application)**: Animation systems update transforms, LOD selection, light probe placement

This clean separation ensures that dynamic object support doesn't leak Vulkan-specific code into gameplay logic, and that performance optimizations don't complicate the high-level rendering interface.

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L1-L223)

## Next Steps

After completing Milestone 3, the renderer will support fully dynamic scenes with production-quality lighting and scalable performance. The next evolution—documented in [Frame Flow and Render Graph Design](https://github.com/1PercentSync/himalaya/blob/main/34-frame-flow-and-render-graph-design)—focuses on advanced frame scheduling, async compute integration, and preparation for future features like real-time GI baking and neural rendering enhancements.

For developers continuing from M2, the recommended implementation order begins with motion vector infrastructure (enabling all temporal effects), followed by the specific features needed for your target scenarios. Each component builds incrementally on the solid foundation established in the previous milestones.
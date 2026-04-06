The rendering pipeline in Himalaya is orchestrated through a **frame-based render graph** that automatically manages resource dependencies, image layout transitions, and synchronization barriers. This architecture separates the high-level frame flow definition from low-level Vulkan synchronization details, enabling passes to declare their resource usage while the graph computes optimal barrier insertion.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L504), [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L1-L580)

## Render Graph Architecture

The `RenderGraph` class serves as the central coordinator for per-frame rendering operations. Unlike persistent scene graphs, the render graph is **rebuilt every frame** following a clear lifecycle: `clear()` → import resources → `add_pass()` → `compile()` → `execute()`. This design enables dynamic frame composition where passes can be conditionally included based on feature toggles, and resource configurations can adapt to runtime changes like resolution scaling or MSAA mode switches.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L210-L240)

### Core Design Principles

The render graph operates on three fundamental principles that distinguish it from lower-level RHI abstractions. **External resource ownership** means the graph tracks but never creates GPU resources—images and buffers are imported via `import_image()` and `import_buffer()` with their handles remaining valid only for the current frame. **Declarative dependency specification** requires each pass to declare its resource accesses (read, write, or read-write) along with the pipeline stage context, enabling the graph to compute precise barrier requirements. **Automatic synchronization** is achieved during `compile()` which walks passes in registration order, tracking each resource's current layout and emitting `VkImageMemoryBarrier2` structures only when layout changes or data hazards are detected.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L88-L130), [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L414-L500)

### Resource Usage Declaration

Passes declare their resource dependencies through `RGResourceUsage` structures that combine a resource identifier with access type and pipeline stage. The `RGAccessType` enum distinguishes read-only sampling, write-only output, and simultaneous read-write operations (used for depth testing with depth write). The `RGStage` enum maps to Vulkan pipeline stages and determines the `VkImageLayout` for barrier computation—ColorAttachment produces `COLOR_ATTACHMENT_OPTIMAL`, Fragment sampling produces `SHADER_READ_ONLY_OPTIMAL`, and Compute read-write operations use `GENERAL` layout.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L108-L130), [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L97-L170)

## Managed Resource System

Beyond imported external resources, the render graph provides a **managed resource system** for transient render targets that persist across frames but are recreated when configuration changes. Managed images are created once via `create_managed_image()` with either Relative sizing (fraction of reference resolution) or Absolute sizing (fixed pixels), then imported per-frame using `use_managed_image()`.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L280-L350)

### Temporal Resource Double-Buffering

Temporal effects like ambient occlusion reprojection require access to previous frame data. When `temporal=true` is specified during managed image creation, the graph allocates **two backing images** and automatically swaps them each frame during `clear()`. The `get_history_image()` method imports the previous frame's content with appropriate layout transitions, while `is_history_valid()` indicates whether history contains meaningful data (false on first frame or after resize).

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L340-L360), [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L72-L80)

### Dynamic Resolution Adaptation

The `set_reference_resolution()` method enables automatic resource rebuilding when the output resolution changes. For Relative-sized managed images, the graph compares resolved dimensions before and after the reference change, destroying and recreating backing images only when their pixel dimensions actually differ. This mechanism supports window resizing and dynamic resolution scaling without manual pass coordination.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L172-L210)

## Frame Compilation and Execution

The `compile()` phase transforms declarative pass definitions into executable barrier sequences. For each pass, the graph examines its resource declarations and compares required layout/stage/access against the resource's current state. A barrier is emitted when either the layout changes or a data hazard exists—defined as any write followed by a read (RAW), write followed by write (WAW), or read followed by write (WAR). Read-after-read (RAR) dependencies require no synchronization.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L414-L480)

### Barrier Optimization Strategy

The compilation algorithm tracks per-resource state across the entire frame, ensuring that consecutive passes accessing the same resource in compatible states incur zero barrier overhead. For imported images with specified `final_layout`, the graph appends end-of-frame transitions to restore resources to their expected state for external consumption or cross-frame persistence.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L480-L500)

### Execution with Debug Instrumentation

During `execute()`, each pass is wrapped in debug label regions with automatically generated distinct colors using golden-angle hue distribution. This enables clear visualization in RenderDoc and Nsight Graphics without manual pass instrumentation. Barriers are batched through `VkDependencyInfo` and submitted via `vkCmdPipelineBarrier2` for synchronization2 efficiency.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L502-L540), [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L20-L50)

## Rasterization Frame Flow

The complete rasterization pipeline follows a multi-phase architecture where each phase corresponds to a logical rendering stage. The `Renderer::render_rasterization()` method constructs this pipeline by importing managed resources into the graph, populating a `FrameContext` with per-frame data, and invoking pass record methods in dependency order.

Sources: [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L200-L368)

### Phase Structure

| Phase | Pass | Input Resources | Output Resources | Purpose |
|-------|------|-----------------|------------------|---------|
| 1 | Shadow Pass | Scene meshes, light parameters | Shadow Map Array | CSM shadow map generation |
| 2 | Depth PrePass | Visible opaque meshes | Depth (MSAA), Normal, Roughness | Early depth + G-buffer |
| 3 | GTAO Pass | Depth, Normal | AO Noisy | Screen-space ambient occlusion |
| 4 | AO Spatial | AO Noisy | AO Blurred | 5×5 bilateral blur |
| 5 | AO Temporal | AO Blurred, AO History, Depth | AO Filtered | Temporal reprojection |
| 6 | Contact Shadows | Depth, light direction | Contact Shadow Mask | Screen-space shadows |
| 7 | Forward Pass | All G-buffers, lighting data | HDR Color (MSAA) | Main lighting |
| 8 | Skybox Pass | Depth | HDR Color | Background fill |
| 9 | Tonemapping | HDR Color | Swapchain | Tone mapping + UI |

Sources: [m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L1-L242)

### MSAA Integration Strategy

When MSAA is enabled, the Depth PrePass renders to multi-sampled depth, normal, and roughness buffers, then resolves them to single-sampled targets using `VK_RESOLVE_MODE_MAX_BIT` for depth (preserving nearest sample) and `VK_RESOLVE_MODE_AVERAGE_BIT` for color data. Screen-space effects (GTAO, Contact Shadows) operate on resolved single-sampled buffers, while the Forward Pass renders to MSAA HDR color with final resolve occurring before post-processing.

Sources: [depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L130-L200), [forward_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/forward_pass.cpp#L130-L180)

## Pass Implementation Pattern

Individual render passes follow a consistent three-phase lifecycle: `setup()` for one-time pipeline creation, `record()` for per-frame graph registration, and `destroy()` for resource cleanup. The `record()` method receives the `RenderGraph` and `FrameContext`, declares resource usage via `RGResourceUsage` arrays, and provides an execute lambda that performs actual rendering.

Sources: [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L1-L119), [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L100-L177)

### FrameContext as Data Carrier

The `FrameContext` structure aggregates all per-frame data required by passes: RG resource identifiers for the current frame's imported images, non-owning references to scene data (meshes, materials, culling results), instancing draw groups pre-sorted by the renderer, and configuration pointers for feature toggles. This single-structure approach minimizes parameter passing overhead while maintaining clear data flow boundaries.

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L1-L151)

## Path Tracing Alternative Flow

When path tracing mode is active, the rasterization pipeline is bypassed entirely in favor of a simplified compute-focused flow. The PT Reference View Pass uses ray tracing pipelines to accumulate samples into an `RGBA32F` accumulation buffer, which is then tonemapped directly to the swapchain. This separation ensures that rasterization overhead does not interfere with path tracing performance, and that PT can operate even when scene complexity exceeds rasterization memory budgets.

Sources: [m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L140-L180), [renderer.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer.cpp#L130-L160)

## Resource Lifecycle Management

Managed images are created during renderer initialization with explicit format, usage, and sizing specifications. The renderer maintains `RGManagedHandle` members for each transient resource (HDR color, depth, normals, AO buffers), importing them per-frame through the graph's managed resource API. When MSAA settings change, `update_managed_desc()` triggers pipeline rebuilds and potentially resource recreation if sample counts affect resolve target configurations.

Sources: [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L30-L200)

## Integration with RHI Layer

The render graph sits atop the RHI (Rendering Hardware Interface) layer, utilizing `ResourceManager` for image/buffer handle resolution and `CommandBuffer` for barrier submission. This layering ensures that graph-level decisions about pass ordering and synchronization remain independent of Vulkan-specific command recording details, while still leveraging modern Vulkan features like synchronization2 and dynamic rendering.

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L15-L25)

## Next Steps

Understanding the frame flow provides the foundation for extending the rendering pipeline. To implement new rendering features, explore [Render Graph System](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system) for deeper resource management patterns, [Depth PrePass and Forward Rendering](https://github.com/1PercentSync/himalaya/blob/main/18-depth-prepass-and-forward-rendering) for geometry pass implementation details, or [Ambient Occlusion (GTAO)](https://github.com/1PercentSync/himalaya/blob/main/20-ambient-occlusion-gtao) for screen-space effect integration patterns.
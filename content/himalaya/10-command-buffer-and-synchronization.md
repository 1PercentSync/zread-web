This page documents the command buffer abstraction and synchronization mechanisms in the Himalaya RHI (Rendering Hardware Interface). The system is built on Vulkan 1.4 with modern synchronization primitives (Synchronization2) and provides a thin but safe wrapper around raw Vulkan command buffers while managing frame-level GPU synchronization through a multi-buffered frame data architecture.

## Command Buffer Architecture

The **CommandBuffer** class in the RHI layer provides a thin, type-safe wrapper around `VkCommandBuffer`. Unlike many abstraction layers that own their underlying resources, this wrapper operates on a non-owning principle—the caller (specifically the per-frame `FrameData` structure) manages the command buffer's lifetime, while the wrapper provides convenient methods for recording commands. This design choice reflects the engine's philosophy of explicit resource management with ergonomic APIs.

The wrapper exposes methods for all major Vulkan operations: graphics pipeline binding, draw calls, compute dispatches, dynamic state changes, and synchronization primitives. All methods are marked `const` to emphasize that they don't modify the wrapper's logical state—only the underlying Vulkan command buffer's recording state changes. Methods follow a consistent naming convention that maps directly to Vulkan operations without the `vkCmd` prefix, making the API immediately recognizable to Vulkan developers while eliminating boilerplate.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L27-L47), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L10-L26)

### Recording Lifecycle

Command buffer recording follows a strict lifecycle enforced by the wrapper. The `begin()` method combines `vkResetCommandBuffer` and `vkBeginCommandBuffer` into a single call with `VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT`, reflecting the engine's frame-based rendering approach where command buffers are recorded fresh each frame. The `end()` method finalizes recording. This pairing is intentionally atomic at the API level—there's no use case in the engine for resetting without immediately beginning recording.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L35-L46), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L14-L26)

### Graphics Commands

The graphics command interface covers the full spectrum of rasterization operations. Pipeline binding accepts a reference to the engine's `Pipeline` struct, extracting both the pipeline handle and layout. Vertex and index buffer binding include sensible defaults for offsets. Draw calls support both indexed and non-indexed variants with full parameter control including instance counts for instanced rendering. Dynamic viewport and scissor state setting enables flexible rendering to different target regions without pipeline recreation.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L59-L117), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L36-L84)

### Compute Commands

Compute operations follow a parallel structure to graphics. The `bind_compute_pipeline()` method switches the command buffer to compute operations, while `dispatch()` launches workgroups. A key feature is the push descriptor support via `push_compute_descriptor_set()`—this leverages Vulkan 1.4's promoted push descriptor functionality to bind resources without pre-allocated descriptor sets. The wrapper provides convenience methods `push_storage_image()` and `push_sampled_image()` that resolve engine resource handles to Vulkan descriptors automatically, eliminating boilerplate for the common case of compute shader inputs/outputs.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L174-L233), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L129-L199)

### Ray Tracing Commands

When ray tracing is supported, the command buffer provides RT pipeline binding and `trace_rays()` dispatch. The RT commands require special initialization via `init_rt_functions()`, which loads extension function pointers through `vkGetDeviceProcAddr` since the standard Vulkan loader doesn't export KHR ray tracing symbols. The `trace_rays()` method uses pre-built shader binding table (SBT) regions stored in the `RTPipeline` structure, ensuring the dispatch parameters are ready at call time.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L301-L338), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L247-L293)

### Extended Dynamic State

The wrapper exposes Vulkan 1.3's extended dynamic state for runtime pipeline configuration. Methods like `set_cull_mode()`, `set_depth_test_enable()`, and `set_depth_compare_op()` allow pipelines to be reconfigured without recreation. This is particularly valuable for shadow mapping where depth bias parameters need dynamic adjustment per-cascade via `set_depth_bias()`. These methods are only valid for pipelines created with the corresponding dynamic state flags enabled.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L273-L299), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L295-L319)

## Synchronization Primitives

### Pipeline Barriers with Synchronization2

The synchronization interface centers on `pipeline_barrier()`, which accepts a `VkDependencyInfo` structure from the Vulkan Synchronization2 API. This modern approach replaces the legacy pipeline barrier interface with explicit stage and access masks, providing finer-grained control over execution dependencies and memory visibility. The engine uses this through the render graph's automatic barrier insertion, but passes can insert manual barriers when needed for specialized synchronization scenarios.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L119-L125), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L86-L88)

### Resource Transfers

Buffer-to-image copy operations are wrapped via `copy_buffer_to_image()`, using the `VkCopyBufferToImageInfo2` structure from Synchronization2. This is primarily used for uploading block-compressed texture data (BC6H/BC7) from staging buffers to GPU images during initialization.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L127-L135), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L202-L204)

## Frame-Level Synchronization

### Frame Data Structure

The **FrameData** structure encapsulates all per-frame synchronization and command recording resources. Each in-flight frame owns an independent set of these objects, enabling the CPU to record frame N+1 while the GPU executes frame N. The structure contains a command pool, primary command buffer, render fence, and image acquisition semaphore. A deletion queue provides deferred destruction of resources that may still be referenced by the GPU.

The `kMaxFramesInFlight` constant is set to 2, establishing double-buffering as the baseline. This provides sufficient parallelism for GPU-bound workloads while minimizing memory overhead from per-frame resources.

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L82-L103)

### Frame Lifecycle

The **Context** class manages frame rotation through `current_frame()` and `advance_frame()`. The frame index cycles through 0 to `kMaxFramesInFlight-1`, with each frame's fence indicating when the GPU has finished executing that frame's commands. This design ensures that resources referenced by a frame are not modified or destroyed until execution completes.

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L205-L228)

### Immediate Command Scope

For one-shot blocking operations like resource uploads, the context provides an immediate command scope API via `begin_immediate()` and `end_immediate()`. This uses a dedicated command pool marked with `VK_COMMAND_POOL_CREATE_TRANSIENT_BIT`, decoupled from per-frame pools to allow uploads at any point without conflicting with frame recording. The scope automatically collects staging buffers and destroys them after GPU completion via `push_staging_buffer()`.

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L236-L285), [context.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/context.cpp#L601-L664)

## Render Graph Integration

### Automatic Barrier Generation

The **RenderGraph** class leverages the command buffer's barrier capabilities through automatic insertion. During `compile()`, the graph tracks each image's current layout and last access, emitting `CompiledBarrier` structures when layout changes or data hazards (RAW, WAW, WAR) are detected. The `execute()` method then translates these to `VkImageMemoryBarrier2` structures and calls `pipeline_barrier()`.

The barrier logic distinguishes between write and read access types. Write operations always require barriers for subsequent accesses, while read-after-read (RAR) requires no synchronization. This optimization eliminates unnecessary barriers for read-heavy workloads like deferred shading g-buffer sampling.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L417-L518), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L181-L255)

### Pass Execution Flow

Each render pass executes within a debug label scope (`begin_debug_label` to `end_debug_label`), with barriers inserted before the pass callback. The graph manages layout transitions between passes automatically, ensuring images are in the correct state for each operation. Final layout transitions restore imported images to their declared `final_layout` after all passes complete.

Sources: [render_graph.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/render_graph.cpp#L520-L578)

## Application-Level Synchronization

### Frame Loop Synchronization

The **Application** class orchestrates the complete synchronization sequence in `begin_frame()` and `end_frame()`. The sequence begins with waiting on the current frame's fence via `vkWaitForFences`, ensuring the previous use of this frame slot has completed. The deletion queue is then flushed, safely destroying any deferred resources. After acquiring the next swapchain image with `vkAcquireNextImageKHR`, the fence is reset to unsignaled state in preparation for this frame's submission.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L264-L293)

### Submit and Present

The render submission uses `VkSubmitInfo2` from Synchronization2, specifying a wait semaphore (image available) and signal semaphore (render finished). The command buffer submit info references the frame's primary command buffer recorded by the renderer. Presentation waits on the render-finished semaphore before displaying the image.

When the swapchain becomes suboptimal or the framebuffer resizes, `handle_resize()` performs a `vkQueueWaitIdle` to ensure no GPU references to swapchain images exist before recreation.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L562-L667)

## Debug Instrumentation

### Debug Labels

Debug labels provide GPU profiler integration via `VK_EXT_debug_utils`. The `begin_debug_label()` and `end_debug_label()` methods wrap command sequences with named regions visible in RenderDoc, Nsight, and other profilers. These are no-ops in release builds—the extension is only enabled when validation layers are active. Function pointers are loaded via `init_debug_functions()` at instance creation time.

Sources: [commands.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h#L235-L271), [commands.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/commands.cpp#L206-L242)

### Object Naming

The context provides `set_debug_name()` for assigning human-readable names to Vulkan objects. These names appear in validation layer messages and GPU debugger UIs, significantly improving debugging workflows. Like debug labels, this is a no-op when the debug utils extension is unavailable.

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L262-L274), [context.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/context.cpp#L666-L676)

## Relationship to Other Systems

The command buffer and synchronization architecture forms the foundation upon which higher-level systems are built:

- **[Render Graph System](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system)**: Uses command buffers for pass execution and automatic barrier insertion
- **[Pipeline and Shader System](https://github.com/1PercentSync/himalaya/blob/main/9-pipeline-and-shader-system)**: Provides pipeline objects that command buffers bind
- **[Resource Management](https://github.com/1PercentSync/himalaya/blob/main/8-resource-management-buffers-images-samplers)**: Creates resources that command buffers reference in barriers and descriptor bindings
- **[Context and Device Management](https://github.com/1PercentSync/himalaya/blob/main/7-context-and-device-management)**: Owns the command pools and synchronization primitives that command buffers depend on

The design philosophy emphasizes thin abstractions that don't obscure Vulkan's explicit synchronization model while eliminating repetitive boilerplate. This enables developers to reason about GPU execution timelines with precision while maintaining readable, maintainable code.
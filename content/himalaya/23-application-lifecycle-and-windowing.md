The Application layer serves as the orchestration hub of the Himalaya renderer, bridging the operating system's windowing system with the rendering infrastructure. This layer manages the complete lifecycle from initialization through the frame loop to graceful shutdown, handling window events, coordinating subsystem initialization, and maintaining persistent user configuration. Understanding this layer is essential for developers who need to extend the application, integrate new subsystems, or modify the frame loop behavior.

The architecture follows a clear separation of concerns: **GLFW** provides cross-platform windowing and input, the **Application** class coordinates all subsystems, and the **RHI (Rendering Hardware Interface)** abstracts Vulkan specifics. The frame loop is decomposed into discrete phases that map cleanly to GPU synchronization points, enabling predictable behavior and straightforward debugging.

Sources: [application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L1-L50), [main.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/main.cpp#L1-L21)

## Application Entry Point and Lifecycle

The application's entry point follows a minimal, deterministic pattern that emphasizes explicit resource management over implicit constructors and destructors. The `main()` function creates an `Application` instance and invokes three explicit lifecycle methods: `init()`, `run()`, and `destroy()`. This design ensures that initialization order is fully controlled and that cleanup occurs in the precise reverse order, which is critical for Vulkan where destruction order relative to the device and instance matters significantly.

The three-phase lifecycle provides clear boundaries for subsystem initialization. The `init()` method establishes the complete runtime environment: GLFW initialization, Vulkan context creation, window setup, and loading of the initial scene and environment. The `run()` method enters the blocking frame loop that continues until the user closes the window. Finally, `destroy()` performs orderly teardown, ensuring the GPU is idle before releasing resources. This explicit approach eliminates the subtle ordering bugs that often plague C++ applications relying on destructor ordering.

Sources: [main.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/main.cpp#L14-L20), [application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L32-L45)

## Initialization Sequence

The initialization sequence in `Application::init()` follows a carefully ordered dependency chain where each subsystem becomes available for use by subsequent stages. The sequence begins with logging configuration, proceeds through windowing setup, establishes the Vulkan infrastructure, initializes rendering subsystems, and concludes with scene loading. This ordering ensures that each component's dependencies are satisfied before it is initialized.

The sequence starts by setting the log level to `info` temporarily so that configuration loading diagnostics are visible, then applies the persisted log level from `AppConfig`. GLFW is initialized with the `GLFW_NO_API` hint, which prevents GLFW from creating an OpenGL context since Vulkan will manage its own. The window is created with fixed initial dimensions of 1920×1080 pixels. Following window creation, the Vulkan context is initialized using the window handle for surface creation, the swapchain is created for presentation, and the framebuffer resize callback is registered to detect window dimension changes.

ImGui initialization occurs after the resize callback registration so that ImGui can chain its own callback when `install_callbacks` is enabled. Resource management subsystems—the `ResourceManager` for buffers and images and the `DescriptorManager` for descriptor sets—are initialized next. The camera is configured with an aspect ratio derived from the swapchain extent, and the camera controller is bound to the window for input handling. The renderer initialization is the most substantial step, creating pipelines, default textures, and loading the HDR environment map. Finally, the glTF scene is loaded if a path was provided in the configuration, and ray tracing acceleration structures are built if supported by the hardware.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L24-L115)

## Frame Loop Architecture

The frame loop in `Application::run()` implements a classic game loop pattern with specific accommodations for Vulkan's synchronization requirements and window minimization handling. The loop continues while `glfwWindowShouldClose()` returns false, polling for window events at the start of each iteration. A special handling path exists for minimized windows: when the framebuffer extent reports zero dimensions, the loop blocks on `glfwWaitEvents()` until the window is restored, preventing attempts to render to invalid swapchain images.

Each frame proceeds through four distinct phases: `begin_frame()`, `update()`, `render()`, and `end_frame()`. This decomposition enables clean separation between CPU-side game logic updates and GPU command recording, and it maps directly to Vulkan's synchronization primitives. The loop structure ensures that the CPU can be recording frame N+1 while the GPU is still executing frame N, maximizing hardware utilization through pipelining.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L230-L247)

### Frame Phase: begin_frame()

The `begin_frame()` method manages the transition from CPU frame N-1 completion to CPU frame N recording, handling all synchronization requirements for safe resource reuse. The method first waits on the current frame's render fence, which was signaled when the GPU completed processing the previous submission for this in-flight frame index. This wait ensures that all resources used by the previous frame N-2 are no longer referenced by the GPU.

Following the fence wait, the frame's deletion queue is flushed, executing all deferred destruction lambdas that were enqueued during previous frames. This is the safe point to destroy Vulkan resources because the fence guarantees the GPU has finished all work that might reference them. The method then attempts to acquire the next swapchain image via `vkAcquireNextImageKHR`, using the frame's `image_available_semaphore` for synchronization. If acquisition reports `VK_ERROR_OUT_OF_DATE_KHR`, indicating the window was resized, the method triggers resize handling and returns false to skip the current frame iteration. After successful acquisition, the render fence is reset to unsignaled state in preparation for the upcoming submission, and ImGui's frame is begun via `imgui_backend_.begin_frame()`.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L249-L279), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L95-L115)

### Frame Phase: update()

The `update()` phase handles all per-frame CPU-side state changes that do not involve GPU command recording. This includes processing input, updating camera state, building lighting parameters, performing frustum culling, and rendering the debug UI. The method receives the delta time from ImGui's IO structure for frame-rate independent movement.

Camera updates begin by refreshing the aspect ratio from the current swapchain extent and invoking the camera controller's update method. Lighting is constructed based on the active `LightSourceMode`: for `Fallback` mode, the light direction is computed from yaw and pitch angles; for `HdrSun` mode, the direction is derived from pixel coordinates in the equirectangular environment map combined with the IBL rotation. The `SceneRenderData` structure is populated with mesh instances and lights, then frustum culling is performed to determine visible objects. The debug UI is rendered via `debug_ui_.draw()`, which returns action flags for configuration changes such as scene loading requests or setting modifications.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L281-L400)

### Frame Phase: render()

The `render()` phase records all GPU commands for the frame into the frame's command buffer. A `CommandBuffer` wrapper is created around the raw `VkCommandBuffer` handle to provide higher-level recording methods. The command buffer is begun, a `RenderInput` structure is populated with all frame-specific parameters including camera matrices, light data, culling results, and configuration settings, and the renderer's `render()` method is invoked to record the complete render graph execution.

After command buffer recording completes, the submission structure is prepared. The submission waits on the `image_available_semaphore` at the `COLOR_ATTACHMENT_OUTPUT` stage, ensuring that rendering does not begin until the swapchain image is ready. It signals the swapchain's `render_finished_semaphores` array at the acquired image index upon completion. If the renderer has a pending denoise operation, an additional timeline semaphore signal is included for synchronization with the asynchronous denoiser. The command buffer is submitted to the graphics queue with the frame's render fence, which will be signaled when the GPU completes execution.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L530-L599)

### Frame Phase: end_frame()

The `end_frame()` phase presents the completed frame and handles swapchain state changes. The presentation is performed via `vkQueuePresentKHR`, waiting on the render-finished semaphore corresponding to the acquired image index. The presentation call is checked for several conditions that require swapchain recreation: `VK_ERROR_OUT_OF_DATE_KHR` or `VK_SUBOPTIMAL_KHR` results, an explicit resize flag set by the GLFW callback, or a VSync toggle request. If any condition is met, `handle_resize()` is invoked to recreate the swapchain and dependent resources. Finally, the context's frame index is advanced via `advance_frame()`, cycling between 0 and `kMaxFramesInFlight-1` (typically 0 and 1 for double-buffering).

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L601-L620)

## Window and Swapchain Management

The windowing subsystem uses **GLFW** for cross-platform window creation and event handling, with the **Swapchain** class managing Vulkan's presentation surface and image management. The window is created with a fixed initial size and a resize callback that sets a flag for the frame loop to detect. The swapchain maintains a collection of images provided by the Vulkan driver, with one image view and one render-finished semaphore per image.

The swapchain implementation handles several important Vulkan presentation details. It requests one more image than the minimum required by the surface capabilities to enable triple-buffering headroom, clamped to any maximum limit reported by the driver. The render-finished semaphores are indexed by the acquired image index rather than the frame index because the presentation engine may hold onto images longer than a single frame period, particularly with MAILBOX present mode where the swapchain may have more images than frames in flight.

Sources: [swapchain.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/swapchain.h#L1-L125), [swapchain.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/swapchain.cpp#L1-L100)

### Resize Handling

Window resize handling requires careful synchronization to prevent use-after-free of resolution-dependent resources. The `handle_resize()` method first waits for the graphics queue to become idle using `vkQueueWaitIdle`, ensuring no GPU commands are in flight. Unlike the per-frame fence waits, this idle wait covers both submitted commands and pending presentation operations. The renderer is notified of the swapchain invalidation, allowing it to destroy resolution-dependent resources like the G-buffer and output images. The swapchain is then recreated with the new window dimensions, and the renderer is notified to rebuild its resources with the new extent.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L622-L628)

## Configuration Persistence

The application maintains persistent configuration through the `AppConfig` structure and associated load/save functions. Configuration is stored as JSON in the user's local application data directory (`%LOCALAPPDATA%\himalaya\config.json` on Windows, or a local directory on other platforms). The configuration includes the last loaded scene path, environment map path, per-HDR sun coordinates for the HdrSun light mode, log level preference, and auto-denoise interval settings.

Configuration is loaded during `init()` to restore the user's previous working state, and saved whenever the user switches scenes, changes environments, or modifies persistent settings through the debug UI. The save operation uses an atomic write pattern: data is written to a temporary file first, then renamed to the target path, ensuring that the configuration file is never in a partially written state even if the application crashes during save.

Sources: [config.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/config.h#L1-L76), [config.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/config.cpp#L1-L142)

## Multi-Frame In-Flight Support

The renderer implements double-buffering through the `kMaxFramesInFlight` constant set to 2, meaning the CPU can be recording frame N+1 while the GPU is executing frame N. Each in-flight frame owns independent synchronization primitives: a command pool, command buffer, render fence, and image-available semaphore. The `FrameData` structure encapsulates these per-frame resources, and the `Context` class provides `current_frame()` and `advance_frame()` methods to manage the cycling between frame slots.

The deletion queue mechanism enables safe destruction of GPU resources without stalling the CPU. When a resource is no longer needed, a destruction lambda is pushed into the current frame's deletion queue. These lambdas are executed after the frame's fence is waited on in `begin_frame()`, guaranteeing that the GPU has finished all work referencing the resources before they are destroyed.

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L78-L93), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L240-L250)

## Runtime Scene and Environment Switching

The application supports runtime switching of both scenes and environment maps without restart. The `switch_scene()` method waits for the graphics queue to become idle, destroys the current scene data, loads the new glTF file, and rebuilds ray tracing acceleration structures if supported. The `switch_environment()` method similarly waits for idle, then invokes the renderer's environment reload method. Both methods update the persisted configuration and handle error states gracefully, displaying error messages in the debug UI if loading fails.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L117-L177)

## Input Handling

The application processes several categories of input through different mechanisms. Camera movement uses GLFW's input polling within the camera controller, which checks key states each frame for WASD movement and mouse look. The debug UI captures input through ImGui's event handling when the mouse is over UI elements. A special left-click drag gesture is handled directly in `update_drag_input()`: without modifier keys, dragging rotates the IBL environment horizontally; with Alt held, dragging rotates the fallback light direction.

Sources: [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L630-L665)

## Related Documentation

For a deeper understanding of how the application coordinates with lower-level systems, refer to the following pages:

- **[Context and Device Management](https://github.com/1PercentSync/himalaya/blob/main/7-context-and-device-management)** — Details of Vulkan instance creation, physical device selection, and queue management
- **[Renderer Orchestration](https://github.com/1PercentSync/himalaya/blob/main/24-renderer-orchestration)** — How the Application delegates rendering to the Renderer subsystem
- **[Scene Loading (glTF)](https://github.com/1PercentSync/himalaya/blob/main/25-scene-loading-gltf)** — The scene loading pipeline invoked during initialization and scene switching
- **[Camera Controller and Debug UI](https://github.com/1PercentSync/himalaya/blob/main/26-camera-controller-and-debug-ui)** — Input handling and user interface implementation
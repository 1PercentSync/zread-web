The application layer provides the bridge between user input and the rendering engine through two primary components: the **Camera Controller** for navigation and the **Debug UI** for runtime inspection and tuning. These systems transform raw input into meaningful camera movement and expose the engine's internal state through an interactive ImGui panel, enabling both exploration of 3D scenes and real-time debugging of rendering parameters.

## Camera Controller: WASD Navigation with Mouse Look

The `CameraController` class implements a familiar first-person navigation system found in games and 3D authoring tools. It translates keyboard and mouse input into camera movement, allowing users to freely explore loaded scenes.

### Input Handling Architecture

The controller follows a simple state machine pattern that distinguishes between **UI interaction mode** and **camera control mode**. When you hold the right mouse button, the cursor disappears and mouse movements rotate the camera. Releasing the button returns control to the UI. This design prevents accidental camera movement when interacting with ImGui widgets while ensuring smooth navigation when intentionally exploring the scene.

The implementation carefully handles edge cases around ImGui input capture. When rotation is active, the controller ignores `WantCaptureMouse` to prevent flickering that would occur if the virtual cursor drifted over UI elements. For keyboard movement, it uses `WantTextInput` rather than `WantCaptureKeyboard`—this distinction matters because with keyboard navigation enabled in ImGui, `WantCaptureKeyboard` would be true whenever any widget is focused, permanently blocking WASD movement. The text input check only blocks movement during actual text entry.

Sources: [camera_controller.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/camera_controller.cpp#L26-L103)

### Movement Controls

| Key | Action |
|-----|--------|
| W / S | Move forward / backward |
| A / D | Move left / right |
| Space | Ascend (world up) |
| Left Ctrl | Descend (world down) |
| Left Shift | Sprint (3x speed multiplier) |
| Right Mouse (hold) | Enable mouse look |
| F | Focus camera on scene bounds |

The movement system operates in camera-local space: forward and backward move along the camera's viewing direction, while left and right move perpendicular to it. The vertical axis (Space/Ctrl) always moves in world space (Y-up), preventing disorientation when looking up or down. The sprint multiplier of 3.0x provides quick traversal for large scenes without sacrificing precision for detailed examination.

Sources: [camera_controller.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/camera_controller.cpp#L72-L103)

### Focus Target System

The F-key focus feature automatically positions the camera to frame the entire scene. When `set_focus_target()` receives an AABB (axis-aligned bounding box), pressing F computes a camera position that keeps the current orientation while ensuring the scene fits within the view frustum. The calculation uses the bounding sphere of the AABB and the tighter of the vertical or horizontal field of view to ensure the scene fits regardless of viewport aspect ratio.

Sources: [camera_controller.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/camera_controller.cpp#L21-L23), [camera.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/camera.cpp#L41-L57)

## Camera Data Structure and Matrix Math

The `Camera` struct in the framework layer stores both input state (position, orientation, projection parameters) and derived state (view and projection matrices). This separation allows the controller to modify input values directly while the renderer consumes the pre-computed matrices.

### Reverse-Z Projection

The camera uses **reverse-Z projection**, a technique that maps the near plane to depth 1 and the far plane to depth 0. This provides superior depth precision for distant objects compared to traditional projection. The implementation requires `GLM_FORCE_DEPTH_ZERO_TO_ONE` and Vulkan's `VK_COMPARE_OP_GREATER` depth comparison. The projection matrix is constructed manually rather than using `glm::perspective` to achieve this mapping:

```
projection[2][2] = near / (far - near)
projection[2][3] = -1
projection[3][2] = near * far / (far - near)
```

Sources: [camera.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/camera.h#L21-L62), [camera.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/camera.cpp#L15-L28)

### Direction Vectors

The camera computes direction vectors from yaw and pitch angles:
- **Forward**: Derived from spherical coordinates, with yaw=0 looking along -Z
- **Right**: Always horizontal (no roll), perpendicular to forward in the XZ plane
- **Up**: Implicitly (0, 1, 0) through the use of `glm::lookAt`

The view matrix is constructed using `glm::lookAt` with the world up vector, ensuring consistent orientation regardless of pitch.

Sources: [camera.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/camera.cpp#L59-L75)

## Debug UI: Runtime Inspection and Control

The `DebugUI` class provides a comprehensive ImGui panel that displays frame statistics, GPU information, and exposes nearly all runtime-tunable rendering parameters. It follows a **stateless design** where all data flows in through `DebugUIContext` and user actions flow out through `DebugUIActions`, making it easy to integrate without creating complex dependencies.

### Frame Statistics

The `FrameStats` inner class accumulates per-frame delta times and computes statistics every second:
- **Average FPS**: Mean frame rate over the update interval
- **Average frame time**: Mean milliseconds per frame
- **1% Low FPS**: Frame rate computed from the worst 1% of frame times (indicates stutter)

The 1% low metric is particularly valuable for identifying intermittent performance issues that average FPS might hide. By sorting frame times and averaging the slowest 1%, it quantifies the severity of frame time spikes.

Sources: [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L102-L137)

### Panel Organization

The debug panel organizes controls into collapsible sections:

| Section | Purpose |
|---------|---------|
| Header | FPS, GPU name, resolution, VRAM usage, VSync toggle |
| Path Tracing | PT-specific controls (bounces, firefly clamp, sampling options) |
| Denoiser | OIDN controls (auto/manual denoise, display toggle) |
| Camera | Position readout, FOV/near/far sliders |
| Scene | File loading, asset counts, culling statistics |
| Environment | HDR environment loading and display |
| Lighting | Light source mode selection, intensity/color controls |
| Features | Master toggles for skybox, shadows, AO, contact shadows |
| Shadow | Cascade settings, PCF/PCSS mode selection, bias controls |
| Ambient Occlusion | GTAO radius, directions, steps, temporal blend |
| Contact Shadows | Ray step count, distance, thickness parameters |
| Rendering | MSAA selection, shader reload, IBL intensity, exposure, debug views |
| Cache | Manual cache clearing for textures, IBL, and shaders |

Sources: [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L141-L728)

### Deferred Slider Pattern

Several controls use a custom "deferred" slider pattern that prevents intermediate values from affecting the renderer during text input. When you Ctrl+Click a slider to type a value, the underlying parameter remains at its pre-edit value until you press Enter or click away. This prevents the renderer from seeing partial keystrokes (like "1" while typing "100") that would cause visual flicker or expensive intermediate recomputation.

The pattern works by saving the original value before calling `ImGui::SliderFloat`, then restoring it if the item is active and `WantTextInput` is true. The change is only committed when text input completes.

Sources: [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L57-L98)

### Action-Based Side Effects

Rather than directly modifying engine state, the Debug UI returns actions that the application processes. This decoupling allows the UI to be stateless while enabling the application to handle complex side effects like resource recreation. For example, changing MSAA sample count or shadow map resolution requires rebuilding render targets—the UI signals this through `DebugUIActions`, and the application performs the recreation at a safe point in the frame.

Key actions include:
- `vsync_toggled`: Requires swapchain recreation
- `msaa_changed`: Requires render target recreation
- `shadow_resolution_changed`: Requires shadow map recreation
- `scene_load_requested` / `env_load_requested`: Async file loading
- `reload_shaders`: Hot-reload shader compilation
- `pt_reset_requested`: Clear path tracing accumulation
- `pt_denoise_requested`: Manual denoise trigger

Sources: [debug_ui.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/debug_ui.h#L241-L295)

### Debug Render Modes

The Rendering section provides a combo box for switching between visualization modes that help debug material and lighting issues:

| Mode | Description |
|------|-------------|
| Full PBR | Normal rendered output |
| Diffuse Only | Albedo × (diffuse lighting) |
| Specular Only | Specular reflections only |
| IBL Only | Image-based lighting contribution |
| Normal | World-space normal vectors |
| Metallic | Metallic channel visualization |
| Roughness | Roughness channel visualization |
| AO | Ambient occlusion only |
| Shadow Cascades | Color-coded cascade visualization |
| SSAO | Screen-space AO debug |
| Contact Shadows | Contact shadow debug view |

These modes are invaluable for validating that individual lighting components behave correctly and for identifying which part of the rendering pipeline might be causing visual artifacts.

Sources: [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L694-L703)

## Integration with Application Loop

The typical integration pattern in the application loop follows this sequence:

1. **Poll input**: `glfwPollEvents()` processes window messages
2. **Update camera**: `camera_controller.update(delta_time)` processes input and updates camera matrices
3. **Begin ImGui frame**: `ImGui::NewFrame()` starts UI construction
4. **Draw debug UI**: `debug_ui.draw(context)` builds the panel and returns actions
5. **Process actions**: Application inspects `DebugUIActions` and applies side effects
6. **Render**: Camera matrices and UI state feed into the render graph execution

This separation of concerns keeps input handling, UI construction, and rendering distinct while allowing them to communicate through well-defined data structures.

## Next Steps

With an understanding of camera navigation and runtime debugging, you can explore how the application orchestrates the entire rendering pipeline. The [Renderer Orchestration](https://github.com/1PercentSync/himalaya/blob/main/24-renderer-orchestration) page describes how the application coordinates render passes, manages resource lifetimes, and integrates the camera and debug UI into the frame flow. For understanding how scenes are prepared for rendering, see [Scene Loading (glTF)](https://github.com/1PercentSync/himalaya/blob/main/25-scene-loading-gltf).
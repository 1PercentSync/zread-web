Himalaya is a Vulkan 1.4-based real-time renderer built with a strict layered architecture that enforces unidirectional dependencies. The codebase is organized into four distinct layers, each compiled as a separate CMake static library, ensuring that architectural boundaries are enforced at compile time. This design enables incremental development, where each milestone adds new render passes without modifying existing code, and supports both rasterization and path tracing rendering paths within the same codebase.

The architecture follows a "rendering view" abstraction where the renderer does not directly manipulate game logic objects. Instead, it receives a structured set of renderable objects, lights, and camera parameters each frame. This separation enables multi-view rendering scenarios such as cascaded shadow maps, reflection probes, and VR stereo rendering without duplicating scene data.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L1-L203), [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L1-L50)

## Four-Layer Architecture

The renderer is organized into four strictly ordered layers with dependencies flowing only downward:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Application Layer (himalaya_app)                  │
│  Scene loading, camera control, debug UI, demo logic         │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Render Pass Layer (himalaya_passes)               │
│  Individual render passes: DepthPrePass, ForwardPass,       │
│  GTAOPass, ShadowPass, TonemappingPass, etc.                │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Render Framework (himalaya_framework)             │
│  RenderGraph, MaterialSystem, Mesh management, IBL,         │
│  Camera, Scene data structures                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: RHI - Rendering Hardware Interface (himalaya_rhi) │
│  Vulkan abstraction: Context, Resources, Pipelines,         │
│  Command buffers, Descriptors, Swapchain                    │
└─────────────────────────────────────────────────────────────┘
```

Each layer is a static library with explicit CMake dependencies: `rhi ← framework ← passes ← app`. Reverse dependencies are prohibited—Layer 0 knows nothing about shadows or SSAO, and individual passes communicate only through the Render Graph's resource declarations.

Sources: [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L130-L145)

### Layer 0: RHI (Rendering Hardware Interface)

The RHI layer provides a thin abstraction over Vulkan, exposing resource handles, command recording, and synchronization primitives without introducing heavy abstraction overhead. It encapsulates device management, memory allocation via VMA (Vulkan Memory Allocator), and bindless descriptor indexing for texture access.

Key components include the [Context](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L112-L325) which owns the Vulkan instance, device, queues, and ray tracing extension function pointers; the [ResourceManager](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/resources.h#L200-L531) which manages generation-based handles for buffers, images, and samplers; and the [CommandBuffer](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/commands.h) wrapper that provides type-safe recording of draw and dispatch commands.

Resource handles use a generation-based scheme where each handle contains an index and generation counter. When a resource is destroyed, its slot's generation increments, invalidating all existing handles to prevent use-after-free errors. This design allows the upper layers to pass lightweight handles rather than raw Vulkan objects.

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L14-L74), [rhi/include/himalaya/rhi/context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L39-L165), [rhi/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/rhi/CMakeLists.txt#L1-L24)

### Layer 1: Render Framework

The framework layer provides the structural backbone for rendering without implementing specific visual effects. Its centerpiece is the [RenderGraph](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L181-L504), a declarative system where each pass declares its input and output resources. The graph automatically computes execution order, inserts memory barriers, and manages resource layout transitions between passes.

The framework also includes the [MaterialSystem](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h) for shader variant management and PBR parameter handling, [Mesh](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/mesh.h) and geometry management with vertex/index buffer handling, [IBL](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/ibl.h) for image-based lighting environment processing, and [SceneData](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L1-L200) structures that define the contract between application and renderer.

The Render Graph supports both managed images (automatically resized with the viewport) and imported images (pass-owned resources with fixed dimensions). This distinction is critical for resources like shadow map arrays that do not follow screen resolution but still participate in barrier management.

Sources: [framework/include/himalaya/framework/render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L200), [framework/include/himalaya/framework/scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L1-L100), [framework/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/framework/CMakeLists.txt#L1-L47)

### Layer 2: Render Passes

Each render pass is a self-contained module implementing a specific rendering effect. Passes declare their resource dependencies through the Render Graph and provide an execute callback that records commands into a command buffer. This design ensures that adding or removing a pass requires no changes to other passes—they communicate only through named resources.

Current passes include [DepthPrePass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h) for early depth filling with reverse-Z, [ForwardPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L35-L118) for main lighting with PBR shading, [GTAOPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/gtao_pass.h) for ground-truth ambient occlusion, [ShadowPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h) for cascaded shadow map generation, [ContactShadowsPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h) for screen-space contact shadows, and [TonemappingPass](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h) for HDR to LDR conversion.

Each pass follows a standard interface: `setup()` for one-time initialization, `record()` for per-frame Render Graph registration, and `destroy()` for cleanup. Passes do not hold references to other passes—they only declare resource names like "SceneDepth" or "AOResult" that the Render Graph connects.

Sources: [passes/include/himalaya/passes/forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L1-L119), [passes/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/passes/CMakeLists.txt#L1-L19)

### Layer 3: Application

The application layer orchestrates the rendering pipeline without containing rendering logic itself. The [Application](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h) class manages window creation via GLFW, the frame loop, and initialization sequencing. It fills the [RenderInput](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/renderer.h#L59-L117) structure each frame with camera state, visible object lists, and feature toggles, then delegates to the [Renderer](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/renderer.h#L129-L200) class.

The [Renderer](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/renderer.h#L129-L200) owns all render passes, GPU buffers, and shared resources. It translates the semantic RenderInput into GPU-side uniform buffers and SSBOs, builds the per-frame Render Graph, and executes it. The renderer handles both rasterization and path tracing modes, switching between them based on the render mode specified in the input.

Additional application components include [CameraController](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/camera_controller.h) for input handling and camera movement, [SceneLoader](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/scene_loader.h) for glTF scene import, and [DebugUI](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/debug_ui.h) for ImGui-based parameter tuning.

Sources: [app/include/himalaya/app/renderer.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/renderer.h#L1-L200), [app/src/application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L1-L100), [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L1-L39)

## Frame Flow Architecture

A typical frame flows through the system as a data transformation pipeline:

1. **CPU Preparation**: Application performs frustum culling and transparent object sorting, producing index lists into the scene data
2. **Shadow Generation**: ShadowPass renders cascaded shadow maps for directional lights
3. **Depth/Normal PrePass**: DepthPrePass fills MSAA depth and normal buffers for opaque geometry
4. **Screen-Space Effects**: GTAOPass and ContactShadowsPass operate on resolved single-sample buffers
5. **Main Lighting**: ForwardPass renders opaque objects with PBR shading, sampling shadows and AO
6. **Post-Processing**: TonemappingPass converts HDR to LDR for display

The Render Graph automatically inserts memory barriers between passes based on declared resource usage. Passes that have no data dependencies (such as GTAO and Contact Shadows) execute without intervening barriers, allowing GPU overlap.

Sources: [docs/milestone-1/m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L1-L100)

## Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **Generation-based handles** | Lightweight, use-after-free detection, no raw Vulkan types in upper layers |
| **Render Graph barrier automation** | Eliminates manual VkImageMemoryBarrier management, reduces bugs as passes are added |
| **Pass-level pluggability** | Each effect is self-contained; disabling SSAO removes one node, graph auto-adjusts |
| **Bindless descriptors** | All textures in global array indexed at runtime; simplifies material system and shadow atlases |
| **Reverse-Z depth** | near=1, far=0 with GREATER comparison improves depth precision distribution |
| **2 frames in flight** | CPU records frame N+1 while GPU executes frame N; balances latency and throughput |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L165-L180), [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L1-L50)

## Reading Path

To understand the architecture in depth, follow this progression through the documentation:

1. **[Requirements and Design Philosophy](https://github.com/1PercentSync/himalaya/blob/main/4-requirements-and-design-philosophy)** — Core goals and constraints that shaped the architecture
2. **[Technical Decisions and Technology Stack](https://github.com/1PercentSync/himalaya/blob/main/6-technical-decisions-and-technology-stack)** — Detailed technology choices and alternatives considered
3. **[Context and Device Management](https://github.com/1PercentSync/himalaya/blob/main/7-context-and-device-management)** — Layer 0 initialization and Vulkan setup
4. **[Render Graph System](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system)** — How the frame orchestration system works
5. **[Frame Flow and Render Graph Design](https://github.com/1PercentSync/himalaya/blob/main/34-frame-flow-and-render-graph-design)** — Complete pass-by-pass data flow documentation

For developers extending the renderer, the typical workflow is: implement new effects as passes in Layer 2, register them with the Render Graph in the Renderer class, and expose toggles through the DebugUI. The architecture ensures that new passes integrate without modifying existing code.
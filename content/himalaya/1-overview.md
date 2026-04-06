**Himalaya** is a Vulkan 1.4-based real-time renderer designed as a personal learning and demonstration project. It begins with rasterization rendering while architecturally preparing for future hybrid ray tracing and pure path tracing pipelines. The project targets medium-tier desktop gaming hardware and high-end PCVR devices, pursuing the "sweet spot" where performance cost and visual quality achieve optimal balance.

The renderer is organized around a **four-layer architecture** with strict compile-time unidirectional dependencies. This design ensures that lower layers remain agnostic of upper layers, promoting modularity and reducing the blast radius of changes. The architecture emphasizes a **Render Graph** system for declarative frame management, where each rendering pass declares its resource inputs and outputs, allowing the system to handle execution ordering, resource lifetime, synchronization barriers, and resource aliasing automatically.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L1-L50), [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L90-L103)

## What Himalaya Is

Himalaya is built for developers who want to understand modern real-time rendering from the ground up. It demonstrates production-quality techniques including Forward+ rendering, Cascaded Shadow Maps (CSM), Ground-Truth Ambient Occlusion (GTAO), Image-Based Lighting (IBL), and a complete path tracing reference view with GPU baking capabilities. The codebase prioritizes **architectural clarity** over clever optimizations, making it an excellent reference for learning how a modern renderer is structured.

The project follows a **milestone-driven development approach**. Milestone 1 focuses on static scene rendering with baked global illumination, while Milestone 2 introduces dynamic sky systems, screen-space effects, and real-time path tracing. This phased approach allows each subsystem to reach a functional state before adding complexity.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L1-L20), [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L1-L35)

## Architecture at a Glance

The renderer follows a strict four-layer architecture where each layer is a separate CMake static library. Compile-time dependencies flow in one direction only: `rhi ← framework ← passes ← app`.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Application (himalaya_app)                         │
│  - Scene loading (glTF), camera control, debug UI           │
│  - Fills render lists, initiates frame rendering            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Render Passes (himalaya_passes)                    │
│  - Depth PrePass, Forward Pass, Shadow Pass                 │
│  - GTAO, Contact Shadows, Tonemapping                       │
│  - Path Tracing Reference View                              │
│  - Each pass declares inputs/outputs, registers with RG     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Render Framework (himalaya_framework)              │
│  - Render Graph (resource management, barriers)             │
│  - Material System, Mesh Management                         │
│  - Camera, Lighting, IBL Processing                         │
│  - Scene Data and Culling                                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 0: RHI (himalaya_rhi)                                 │
│  - Vulkan 1.4 abstraction (Context, Commands, Resources)    │
│  - Pipeline and Shader Management                           │
│  - Ray Tracing Infrastructure (AS, RT Pipeline)             │
│  - Bindless Descriptor System                               │
└─────────────────────────────────────────────────────────────┘
```

This layered design ensures that the RHI knows nothing about rendering passes, and passes know nothing about each other—they communicate only through Render Graph resource declarations.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L122-L153), [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L104-L169)

## Key Features

| Category | Features |
|----------|----------|
| **Rendering** | Forward+ with Tiled/Clustered light culling, PBR (Metallic-Roughness), Normal mapping |
| **Shadows** | CSM with PCF/PCSS, Contact Shadows (screen-space) |
| **Global Illumination** | Baked Lightmaps (GPU PT), Reflection Probes, SSGI (M2) |
| **Ambient Occlusion** | GTAO with temporal filtering, spatial denoising |
| **Path Tracing** | GPU baking (Lightmaps/Probes), Real-time PT reference view with OIDN denoising |
| **Post-Processing** | Bloom, Auto-exposure, ACES Tonemapping, Vignette, Color Grading |
| **Atmosphere** | Static HDR skybox → Bruneton atmospheric scattering (M2) |
| **Anti-Aliasing** | MSAA, FSR SDK, DLSS SDK (unified interface) |

Sources: [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L33-L91), [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L17-L54)

## Technology Stack

| Component | Library | Purpose |
|-----------|---------|---------|
| Windowing | GLFW 3.4 | Cross-platform window and input |
| Math | GLM 1.0 | Vector/matrix operations (used directly) |
| Logging | spdlog | Structured logging with levels |
| Memory | VMA 3.3 | Vulkan memory allocation |
| Shaders | shaderc | Runtime GLSL → SPIR-V compilation |
| UI | Dear ImGui 1.91 | Debug interfaces and panels |
| Loading | fastgltf 0.9 | glTF 2.0 scene loading |
| Images | stb_image | JPEG/PNG decoding |
| Config | nlohmann/json | JSON serialization |
| Hashing | xxHash | Content-addressable caching |
| Denoising | OIDN | Intel Open Image Denoise (GPU) |

Sources: [vcpkg.json](https://github.com/1PercentSync/himalaya/blob/main/vcpkg.json#L1-L40), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L174-L190)

## Project Structure

```
himalaya/
├── app/                    # Layer 3: Application executable
│   ├── include/himalaya/
│   └── src/               # application.cpp, renderer.cpp, scene_loader.cpp
├── passes/                 # Layer 2: Render passes library
│   ├── include/himalaya/passes/
│   └── src/               # forward_pass.cpp, gtao_pass.cpp, shadow_pass.cpp...
├── framework/              # Layer 1: Render framework library
│   ├── include/himalaya/framework/
│   └── src/               # render_graph.cpp, material_system.cpp, ibl.cpp...
├── rhi/                    # Layer 0: Vulkan RHI library
│   ├── include/himalaya/rhi/
│   └── src/               # context.cpp, commands.cpp, pipeline.cpp...
├── shaders/                # GLSL shader source files
│   ├── common/            # BRDF, bindings, constants
│   ├── rt/                # Ray tracing shaders
│   └── *.comp             # Compute shaders
├── assets/                 # Test scenes (Sponza, DamagedHelmet)
├── docs/                   # Architecture and milestone documentation
└── tasks/                  # Current development tasks
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L122-L150)

## Design Philosophy

Himalaya is guided by several core principles that shape technical decisions:

**Performance-Quality Balance**: The project targets the "sweet spot" of current hardware—techniques that provide significant visual improvement without excessive performance cost. It avoids both over-optimization for low-end devices and features requiring top-tier hardware.

**Progressive Implementation**: Features follow a Pass 1/2/3 approach—start with a working baseline, then add complexity where justified. This ensures the renderer is always functional while allowing incremental refinement.

**Proven Techniques Only**: The project adopts industry-validated approaches with mature implementations and abundant documentation. This is especially important for AI-assisted development where reference material quality directly impacts reliability.

**Replace Rather Than Accumulate**: Some technologies are explicitly transitional. Height fog will be replaced by Bruneton aerial perspective; screen-space god rays will give way to froxel volumetric fog. This keeps the codebase clean while allowing evolution.

**Offline Quality for Real-Time Problems**: The most distinctive design decision is using multiple baked lightmap sets with runtime interpolation to handle time-of-day changes and scene state transitions—achieving offline baking quality with near-zero runtime cost.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L41-L97)

## Current Status

The project is currently in **Milestone 1 Phase 6**, the final phase of the static scene rendering milestone. Major completed systems include:

- Complete RHI with Vulkan 1.4, Dynamic Rendering, and Synchronization2
- Render Graph with automatic barrier insertion and resource management
- Forward+ rendering with PBR materials
- CSM shadows with PCSS soft shadows
- GTAO with temporal filtering
- GPU path tracing baker for lightmaps and reflection probes
- Path tracing reference view with accumulation and OIDN denoising

The upcoming [Milestone 2](https://github.com/1PercentSync/himalaya/blob/main/32-milestone-2-quality-enhancement-and-real-time-pt) will introduce dynamic sky systems, screen-space reflections (SSR), screen-space global illumination (SSGI), and real-time path tracing with ReSTIR DI and SHaRC.

Sources: [milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L1-L35), [milestone-2.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-2.md#L1-L15)

## Where to Go Next

If you're new to Himalaya, follow this reading path to understand the project:

1. **[Quick Start](https://github.com/1PercentSync/himalaya/blob/main/2-quick-start)** — Build and run your first scene
2. **[Development Environment Setup](https://github.com/1PercentSync/himalaya/blob/main/3-development-environment-setup)** — Configure your IDE and toolchain
3. **[Requirements and Design Philosophy](https://github.com/1PercentSync/himalaya/blob/main/4-requirements-and-design-philosophy)** — Understand the "why" behind technical decisions
4. **[Architecture Overview](https://github.com/1PercentSync/himalaya/blob/main/5-architecture-overview)** — Deep dive into the four-layer system
5. **[Technical Decisions and Technology Stack](https://github.com/1PercentSync/himalaya/blob/main/6-technical-decisions-and-technology-stack)** — Specific technology choices and evolution paths

For developers ready to explore the code:

- Start with [Layer 0 — RHI](https://github.com/1PercentSync/himalaya/blob/main/7-context-and-device-management) to understand the Vulkan abstraction
- Move to [Layer 1 — Render Framework](https://github.com/1PercentSync/himalaya/blob/main/12-render-graph-system) for the Render Graph and material system
- Explore [Layer 2 — Render Passes](https://github.com/1PercentSync/himalaya/blob/main/18-depth-prepass-and-forward-rendering) to see how effects are implemented
- Finally, examine [Layer 3 — Application](https://github.com/1PercentSync/himalaya/blob/main/23-application-lifecycle-and-windowing) for scene loading and orchestration
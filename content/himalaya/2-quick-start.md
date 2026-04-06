Welcome to Himalaya — a Vulkan-based real-time renderer designed for learning and experimentation. This guide will get you up and running with your first rendered scene in minutes. Whether you are new to graphics programming or an experienced developer exploring a new codebase, this page provides the essential steps to build, run, and interact with the renderer.

## What You Will Achieve

By the end of this guide, you will have:
- Built the Himalaya renderer from source
- Launched the application with a sample scene
- Learned the basic controls for camera navigation and scene interaction
- Understood where to find configuration files and logs

## Prerequisites

Before building Himalaya, ensure your system meets the following requirements:

| Component | Minimum Requirement |
|-----------|-------------------|
| **Operating System** | Windows 11 (primary development platform) |
| **GPU** | Vulkan 1.4 compatible with ray tracing support (optional, for path tracing features) |
| **Compiler** | MSVC (Visual Studio 2022 or later) |
| **CMake** | Version 4.1 or later |
| **ISPC** | Version 1.30 (for BC7 texture compression) |
| **IDE** | CLion recommended (project configured for CLion) |

**Required Tools:**
- [Vulkan SDK](https://vulkan.lunarg.com/) (1.4 or later)
- [vcpkg](https://vcpkg.io/) (package manager, integrated via manifest mode)

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L25-L35), [vcpkg.json](https://github.com/1PercentSync/himalaya/blob/main/vcpkg.json)

## Build Instructions

Himalaya uses CMake with vcpkg manifest mode for dependency management. All third-party libraries are automatically fetched and built.

### Step 1: Clone the Repository

```bash
git clone <repository-url>
cd himalaya
```

### Step 2: Configure with CMake

Using CLion, the project should auto-detect the CMake configuration. Alternatively, from the command line:

```bash
cmake -B cmake-build-debug -S . -DCMAKE_TOOLCHAIN_FILE=<vcpkg-root>/scripts/buildsystems/vcpkg.cmake
```

### Step 3: Build

```bash
cmake --build cmake-build-debug --config Debug
```

The build produces `himalaya_app.exe` in `cmake-build-debug/app/`. The build process automatically copies shaders and required DLLs (OIDN, Vulkan, etc.) to the output directory.

Sources: [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt), [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L25-L39)

## First Launch

### Running the Application

Execute `himalaya_app.exe` from your build directory:

```bash
./cmake-build-debug/app/himalaya_app.exe
```

On first launch, the application creates a default configuration file at `%LOCALAPPDATA%\himalaya\config.json`. No scene or environment is loaded initially — you will see a gray skybox and can use the Debug UI to load content.

### Loading Your First Scene

The repository includes sample assets for immediate testing:

| Scene | Path | Description |
|-------|------|-------------|
| **Damaged Helmet** | `assets/DamagedHelmet/DamagedHelmet.gltf` | Classic glTF sample — PBR helmet with normal maps |
| **Sponza** | `assets/Sponza/Sponza.gltf` | Crytek Sponza — large indoor scene for testing |
| **Intel Sponza** | `assets/Sponza_Intel/NewSponza_Main_glTF_003.gltf` | Updated Sponza with higher quality textures |

To load a scene:
1. Press `F1` to open the Debug UI panel
2. Navigate to the **Scene** section
3. Click **Browse** and select a `.gltf` or `.glb` file
4. The scene loads automatically and the camera positions itself to frame the content

Sources: [app/src/application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L85-L115), [app/src/config.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/config.cpp#L25-L45)

## Controls and Interaction

### Camera Navigation

| Action | Control |
|--------|---------|
| **Move Forward** | `W` |
| **Move Backward** | `S` |
| **Move Left** | `A` |
| **Move Right** | `D` |
| **Move Up** | `E` |
| **Move Down** | `Q` |
| **Look Around** | Hold `Right Mouse Button` + Move Mouse |
| **Focus on Scene** | `F` (centers camera on scene bounds) |

### Debug UI Panels

Press `F1` to toggle the Debug UI. The interface provides access to:

- **Scene**: Load/switch scenes and environments
- **Rendering**: Toggle features (shadows, AO, contact shadows, skybox)
- **Lighting**: Adjust light source mode, intensity, and direction
- **Shadows**: Configure CSM parameters, PCF/PCSS modes
- **AO**: Adjust GTAO settings and temporal filtering
- **Path Tracing**: Switch to reference view mode for ground-truth comparisons

### Environment and Lighting

Himalaya supports HDR environment maps for image-based lighting:

1. Press `F1` to open Debug UI
2. Navigate to **Scene** → **Environment**
3. Select an `.hdr` file (sample provided at `assets/environment.hdr`)

Once loaded, you can:
- **Rotate Environment**: Hold `Left Mouse Button` + drag horizontally
- **Adjust Sun Position**: Hold `Alt` + `Left Mouse Button` to position the directional light

Sources: [app/include/himalaya/app/application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L150-L200), [app/src/application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L400-L450)

## Configuration Persistence

Himalaya automatically saves your preferences:

| Setting | Location |
|---------|----------|
| **Config File** | `%LOCALAPPDATA%\himalaya\config.json` |
| **Last Scene** | Persisted in config |
| **Last Environment** | Persisted in config |
| **Sun Coordinates** | Per-HDR file in config |
| **Log Level** | Persisted in config |

Example config structure:
```json
{
  "scene_path": "C:/Projects/himalaya/assets/Sponza/Sponza.gltf",
  "env_path": "C:/Projects/himalaya/assets/environment.hdr",
  "log_level": "info",
  "hdr_sun_coords": {
    "C:/Projects/himalaya/assets/environment.hdr": [512, 256]
  }
}
```

Sources: [app/include/himalaya/app/config.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/config.h#L20-L45), [app/src/config.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/config.cpp#L85-L110)

## Rendering Modes

Himalaya supports two primary rendering modes, switchable at runtime via the Debug UI:

| Mode | Description | Use Case |
|------|-------------|----------|
| **Rasterization** | Forward+ renderer with PBR, CSM shadows, GTAO, IBL | Real-time exploration |
| **Path Tracing** | Accumulating ray-traced reference view with OIDN denoising | Ground-truth comparison, baking |

The path tracing mode requires a Vulkan device with ray tracing support. When the camera is stationary, the path tracer accumulates samples over time, progressively refining the image.

Sources: [docs/milestone-1/milestone-1.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/milestone-1.md#L80-L95), [app/include/himalaya/app/application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L195-L200)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Black screen / No scene visible** | Check that a scene is loaded via Debug UI (F1). Verify the glTF file path is correct. |
| **Validation layer errors** | Ensure your Vulkan SDK is up to date. Validation layers are enabled in debug builds. |
| **HDR environment not loading** | Verify the HDR file format (standard equirectangular projection). Check logs for file access errors. |
| **Low FPS** | Reduce MSAA samples, disable contact shadows, or lower AO quality in Debug UI. |
| **Path tracing unavailable** | Verify your GPU supports Vulkan ray tracing extensions (VK_KHR_ray_tracing_pipeline). |

## Architecture at a Glance

Understanding the project structure helps navigate the codebase:

```
himalaya/
├── app/           # Layer 3 — Application (window, scene loading, UI)
├── passes/        # Layer 2 — Render Passes (shadows, AO, forward, etc.)
├── framework/     # Layer 1 — Render Framework (materials, mesh, camera)
├── rhi/           # Layer 0 — Vulkan RHI (resources, pipelines, commands)
├── shaders/       # GLSL shader source files
├── assets/        # Sample scenes and environments
└── docs/          # Documentation
```

The architecture enforces strict单向依赖 (unidirectional dependencies): `rhi ← framework ← passes ← app`. Each layer only depends on the layers below it.

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L120-L180)

## Next Steps

Now that you have Himalaya running, explore these topics to deepen your understanding:

- Learn about the [Development Environment Setup](https://github.com/1PercentSync/himalaya/blob/main/3-development-environment-setup) for advanced configuration
- Understand the [Requirements and Design Philosophy](https://github.com/1PercentSync/himalaya/blob/main/4-requirements-and-design-philosophy) behind architectural decisions
- Explore the [Architecture Overview](https://github.com/1PercentSync/himalaya/blob/main/5-architecture-overview) for a deeper dive into the four-layer design
- Study the [Milestone 1 — Static Scene Rendering](https://github.com/1PercentSync/himalaya/blob/main/31-milestone-1-static-scene-rendering) documentation to understand implemented features

Happy rendering!
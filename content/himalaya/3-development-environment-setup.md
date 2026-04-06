This guide walks you through setting up a complete development environment for the Himalaya rendering engine. Whether you're new to graphics programming or an experienced developer, following these steps will ensure you have all the necessary tools and dependencies to build and run the project successfully.

The Himalaya renderer is a Vulkan 1.4-based real-time rendering engine built with modern C++20. It uses a layered architecture with four distinct modules: RHI (Rendering Hardware Interface), Framework, Passes, and Application. Understanding this structure will help you navigate the codebase as you set up your environment.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L1-L50), [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11)

## Prerequisites Overview

Before diving into installation, let's understand what you'll need. The Himalaya project requires a Windows development environment with specific compiler and toolchain versions. The project is primarily developed on Windows 11 using CLion as the IDE, with MSVC as the compiler and vcpkg for dependency management.

| Component | Required Version | Purpose |
|-----------|-----------------|---------|
| Operating System | Windows 10/11 | Development platform |
| IDE | CLion (recommended) or Visual Studio | Code editing and debugging |
| Compiler | MSVC (Visual Studio 2022+) | C++20 compilation |
| CMake | 4.1+ | Build system generation |
| ISPC Compiler | 1.30+ | SIMD texture compression |
| Vulkan SDK | 1.4+ | Graphics API |
| vcpkg | Latest | Package management |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L20-L30)

## Step 1: Install Visual Studio and MSVC

The project requires MSVC for C++20 support and ISPC compilation. Download Visual Studio 2022 Community (free) or higher from the official Microsoft website. During installation, select the "Desktop development with C++" workload, which includes the MSVC compiler, Windows SDK, and CMake tools.

Make sure the following individual components are selected:
- MSVC v143 - VS 2022 C++ x64/x86 build tools
- Windows 10/11 SDK
- C++ CMake tools for Windows
- Git for Windows

Sources: [technical-decisions.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/technical-decisions.md#L1-L50)

## Step 2: Install CLion (Recommended IDE)

While you can use Visual Studio, CLion is the recommended IDE for this project as it provides excellent CMake integration, powerful refactoring tools, and superior navigation for large C++ codebases. Download CLion from JetBrains and configure it to use the Visual Studio toolchain.

To configure CLion:
1. Open Settings → Build, Execution, Deployment → Toolchains
2. Add a new toolchain and select "Visual Studio"
3. Set the architecture to amd64
4. Ensure CMake is detected automatically or point it to your CMake 4.1+ installation

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L25)

## Step 3: Install CMake 4.1 or Higher

The project requires CMake 4.1 minimum due to modern CMake features used in the build configuration. Download the latest CMake from the official website or install via Chocolatey: `choco install cmake`. Verify the installation by running `cmake --version` in a terminal.

Sources: [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1)

## Step 4: Install ISPC Compiler

ISPC (Intel SPMD Program Compiler) is required for the BC7 texture compression library. Download ISPC 1.30 or later from the official GitHub releases. Extract it to a location on your system and add the directory containing `ispc.exe` to your system's PATH environment variable.

The bc7enc library uses ISPC to generate SIMD-optimized code for multiple instruction sets (SSE2, SSE4, AVX2, AVX512), with runtime selection of the best available implementation.

Sources: [bc7enc/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/third_party/bc7enc/CMakeLists.txt#L1-L27)

## Step 5: Install Vulkan SDK

Download and install the Vulkan SDK (1.4 or higher) from the LunarG website. The SDK includes the Vulkan headers, validation layers, and tools necessary for development. During installation, the installer will automatically set the `VULKAN_SDK` environment variable.

Verify the installation by checking that the `VULKAN_SDK` environment variable points to your installation directory and that `%VULKAN_SDK%\Bin` is in your PATH.

Sources: [technical-decisions.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/technical-decisions.md#L1-L10)

## Step 6: Set Up vcpkg

vcpkg is used in manifest mode to manage all third-party dependencies. The project includes a `vcpkg.json` file that declares all required packages with specific versions.

First, clone vcpkg to a directory of your choice:
```bash
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat
```

Then add vcpkg to your PATH and integrate it with your development environment:
```bash
.\vcpkg integrate install
```

In CLion, configure the vcpkg toolchain by going to Settings → Build, Execution, Deployment → CMake and adding the following to CMake options:
```
-DCMAKE_TOOLCHAIN_FILE=[path-to-vcpkg]/scripts/buildsystems/vcpkg.cmake
```

Sources: [vcpkg.json](https://github.com/1PercentSync/himalaya/blob/main/vcpkg.json#L1-L40)

## Step 7: Understanding Project Dependencies

The project uses numerous third-party libraries managed through vcpkg. Understanding these dependencies helps troubleshoot build issues:

| Library | Version | Purpose |
|---------|---------|---------|
| GLFW3 | 3.4#1 | Window creation and input handling |
| GLM | 1.0.3 | Mathematics library (vectors, matrices) |
| spdlog | 1.17.0 | Logging infrastructure |
| VulkanMemoryAllocator | 3.3.0 | GPU memory management |
| shaderc | 2025.2 | Runtime GLSL to SPIR-V compilation |
| Dear ImGui | 1.91.9 | Debug UI with Vulkan and GLFW bindings |
| fastgltf | 0.9.0 | glTF scene loading |
| stb | 2024-07-29 | Image decoding (JPEG/PNG) |
| nlohmann-json | 3.12.0 | Configuration file parsing |
| xxHash | 0.8.3 | Content hashing for caching |
| mikktspace | 2020-10-06 | Tangent space generation |

Additional libraries included manually:
- **OIDN (Open Image Denoise)**: Pre-built binaries in `third_party/oidn/` for denoising
- **bc7enc**: ISPC-based BC7 texture compression in `third_party/bc7enc/`

Sources: [vcpkg.json](https://github.com/1PercentSync/himalaya/blob/main/vcpkg.json#L1-L40), [framework/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/framework/CMakeLists.txt#L1-L47)

## Step 8: Clone and Configure the Repository

Clone the repository to your local machine:
```bash
git clone [repository-url]
cd himalaya
```

The project structure follows a layered architecture with four main components:

```
himalaya/
├── rhi/           # Layer 0: Vulkan abstraction (himalaya_rhi)
├── framework/     # Layer 1: Rendering framework (himalaya_framework)
├── passes/        # Layer 2: Render passes (himalaya_passes)
├── app/           # Layer 3: Application executable (himalaya_app)
├── shaders/       # GLSL shader source files
├── third_party/   # External libraries (bc7enc, oidn)
└── docs/          # Documentation
```

Dependencies flow in one direction: `rhi ← framework ← passes ← app`. This design ensures clean separation of concerns and prevents circular dependencies.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L120-L150), [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11)

## Step 9: Build the Project

Open the project in CLion. The IDE should automatically detect the CMake configuration. If prompted, select the Visual Studio toolchain and ensure vcpkg integration is active.

CLion will automatically run CMake configuration, which will:
1. Download and build all vcpkg dependencies (first build may take 30+ minutes)
2. Configure the four project modules (rhi, framework, passes, app)
3. Set up ISPC compilation for bc7enc
4. Configure shader copying as a post-build step

To build manually from the command line:
```bash
cmake -B cmake-build-debug -S . -DCMAKE_TOOLCHAIN_FILE=[vcpkg-root]/scripts/buildsystems/vcpkg.cmake
cmake --build cmake-build-debug --config Debug
```

Sources: [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L1-L39)

## Step 10: Verify the Build

After a successful build, you should find the executable at `cmake-build-debug/app/himalaya_app.exe` (or `.exe` in the appropriate configuration directory). The build process automatically copies required files:

- **Shaders**: Copied from `shaders/` to the build directory
- **OIDN DLLs**: All runtime dependencies copied to the executable directory

Run the application to verify everything works correctly. You should see a window open with the renderer initializing.

Sources: [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L25-L39), [main.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/main.cpp#L1-L21)

## Troubleshooting Common Issues

| Issue | Solution |
|-------|----------|
| CMake cannot find vcpkg packages | Ensure `CMAKE_TOOLCHAIN_FILE` points to vcpkg's cmake integration script |
| ISPC not found | Add ISPC directory to PATH and restart CLion |
| Vulkan SDK not found | Verify `VULKAN_SDK` environment variable is set |
| Missing DLLs at runtime | Check that OIDN DLLs were copied to the build directory |
| Shader compilation errors | Verify shader files were copied to the build directory |

## Development Workflow Tips

Once your environment is set up, here are some workflow recommendations:

**Shader Development**: The project uses a hot-reload workflow for shaders. During development, edit the shaders in the build directory (`cmake-build-debug/app/shaders/`). Once satisfied, sync changes back to the source directory (`shaders/`). This is handled automatically by the post-build copy command.

**Code Style**: The project follows strict coding conventions documented in CLAUDE.md. Key points include:
- Use `#pragma once` for header guards
- Include paths use project prefix: `#include <himalaya/rhi/context.h>`
- Javadoc-style documentation for all public interfaces
- Always use braces for control flow statements

**Commit Workflow**: Follow the conventional commit format: `<type>(<scope>): <description>`. Separate code changes from documentation changes into different commits.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L50-L120)

## Next Steps

Now that your development environment is configured, you're ready to explore the Himalaya renderer. Here are the recommended next steps:

1. **[Quick Start](https://github.com/1PercentSync/himalaya/blob/main/2-quick-start)** - Get your first scene running and understand basic operations
2. **[Requirements and Design Philosophy](https://github.com/1PercentSync/himalaya/blob/main/4-requirements-and-design-philosophy)** - Understand the project's guiding principles and constraints
3. **[Architecture Overview](https://github.com/1PercentSync/himalaya/blob/main/5-architecture-overview)** - Deep dive into the layered architecture and how components interact

For those interested in the technical foundation, proceed to [Context and Device Management](https://github.com/1PercentSync/himalaya/blob/main/7-context-and-device-management) to understand how the RHI layer abstracts Vulkan.
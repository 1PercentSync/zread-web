This page documents the **coding conventions and naming standards** used throughout the Himalaya renderer. These rules are not arbitrary style preferences — they form a coherent system designed to make the layered architecture immediately legible. When you see a trailing underscore on a member variable, you know it's private state. When you see `himalaya::rhi::`, you know you're in the hardware abstraction layer. When you see `kMaxFramesInFlight`, you know it's a compile-time constant. Mastering these patterns is the fastest way to read and contribute to this codebase with confidence.

## Language and Standard

The project targets **C++20** with `CMAKE_CXX_STANDARD 20` and `CMAKE_CXX_STANDARD_REQUIRED ON`. All code is compiled as C++20 with no extensions. The shader side uses **GLSL 460** (`#version 460`) targeting **Vulkan 1.4** through shaderc with `shaderc_env_version_vulkan_1_4`. The build system requires **CMake 4.1** or newer.

Sources: [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L192-L196)

## Naming Conventions

The naming system follows a strict, unambiguous mapping between an identifier's syntactic form and its semantic role. There are no exceptions — every name in the codebase obeys these rules.

### C++ Naming Table

| Element | Convention | Example |
|---|---|---|
| Class / Struct | `PascalCase` | `RenderGraph`, `ImageHandle`, `FrameContext` |
| Method / Free function | `snake_case` | `create_image()`, `begin_rendering()`, `update_all()` |
| Private member | `snake_case` + suffix `_` | `device_`, `allocator_`, `resource_manager_` |
| Public member / Local variable | `snake_case` | `width`, `format`, `position` |
| Namespace | `snake_case` | `himalaya::rhi`, `himalaya::framework` |
| Scoped enum value | `PascalCase` | `Format::R8G8B8A8Unorm`, `MemoryUsage::GpuOnly` |
| Compile-time constant | `kPascalCase` | `kMaxFramesInFlight`, `kMaxShadowCascades` |
| Macro | `SCREAMING_CASE` | `VK_CHECK()`, `FEATURE_SHADOWS` |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L98-L109)

### Key Distinctions at a Glance

**Public vs. private members** are distinguished by the trailing underscore. Public struct fields like `position`, `yaw`, and `fov` in `Camera` use bare `snake_case`, while private class members like `context_`, `resource_manager_`, and `cache_` carry the underscore suffix. This makes ownership and encapsulation boundaries visible at the call site without needing an IDE tooltip.

**Constants vs. types** are distinguished by the `k` prefix. `kMaxFramesInFlight` is a `constexpr uint32_t` value, while `FrameData` is a struct type. Both use PascalCase words, but the `k` prefix removes any ambiguity — if it starts with lowercase `k`, it's a value, not a type.

**Enums use `enum class`** exclusively, with `PascalCase` values. The enum type itself is `PascalCase` like any type, and values are `PascalCase` without the enclosing type name: `ShaderStage::Vertex` (not `ShaderStage::eVertex` or `ShaderStage::SHADER_STAGE_VERTEX`).

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L78-L86), [rhi/include/himalaya/rhi/context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L41), [framework/include/himalaya/framework/scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L25-L26), [framework/include/himalaya/framework/camera.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/camera.h#L30-L45)

### GLSL Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Shader file | `snake_case` + stage extension | `forward.frag`, `gtao.comp`, `reference_view.rgen` |
| Shared header | `snake_case.glsl` | `bindings.glsl`, `brdf.glsl`, `constants.glsl` |
| Include guard macro | `SCREAMING_GLSL` | `BINDINGS_GLSL`, `BRDF_GLSL`, `DEPTH_GLSL` |
| GPU struct | `PascalCase` | `GPUMaterialData`, `GPUInstanceData` |
| GPU struct field | `snake_case` | `base_color_factor`, `metallic_factor` |
| Uniform block instance | `snake_case` | `global` (for `GlobalUBO`) |
| Push constant block instance | `snake_case` | `pc` (for `PushConstants`) |
| Function | `snake_case` | `D_GGX()`, `linearize_depth()`, `reconstruct_view_pos()` |
| Local variable / varyings | `snake_case` | `frag_world_pos`, `ndc`, `ao` |
| Constant | `kPascalCase` (C++-style) | `kMaxReceiverPlaneGradient`, `kMaxPenumbraTexels` |
| Feature flag `#define` | `SCREAMING_CASE` | `FEATURE_SHADOWS`, `FEATURE_AO` |

Sources: [shaders/common/bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L189), [shaders/common/brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L14-L16), [shaders/common/constants.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/constants.glsl#L7-L8), [shaders/common/shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L12-L13), [shaders/common/depth.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/depth.glsl#L8-L9)

### Shader File Naming

Shader files follow a **descriptive name + Vulkan stage extension** convention. The descriptive name identifies the rendering pass or feature (e.g., `forward`, `gtao`, `depth_prepass`), and the extension tells shaderc which stage to compile for:

| Extension | Stage | Example |
|---|---|---|
| `.vert` | Vertex | `forward.vert`, `skybox.vert` |
| `.frag` | Fragment | `forward.frag`, `tonemapping.frag` |
| `.comp` | Compute | `gtao.comp`, `ao_spatial.comp` |
| `.rgen` | Ray Generation | `reference_view.rgen` |
| `.rchit` | Closest Hit | `closesthit.rchit` |
| `.rahit` | Any Hit | `anyhit.rahit` |
| `.rmiss` | Miss | `miss.rmiss` |

Shared headers use `.glsl` extension and live in `shaders/common/` for cross-pass utilities or in subdirectories like `shaders/ibl/` and `shaders/rt/` for domain-specific includes.

Sources: [shaders/](https://github.com/1PercentSync/himalaya/blob/main/shaders/), [shaders/common/](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/)

## Namespace Architecture

Namespaces map one-to-one to architectural layers. Every type lives in exactly one namespace, and that namespace tells you which layer the type belongs to — and, critically, which layers it is allowed to depend on:

```
┌─────────────────────────────────────────────────────┐
│  himalaya::app         Layer 3 — Application         │  Depends on all below
├─────────────────────────────────────────────────────┤
│  himalaya::passes      Layer 2 — Render Passes       │  Depends on framework
├─────────────────────────────────────────────────────┤
│  himalaya::framework   Layer 1 — Rendering Framework │  Depends on rhi
├─────────────────────────────────────────────────────┤
│  himalaya::rhi         Layer 0 — Vulkan Abstraction  │  No project dependencies
└─────────────────────────────────────────────────────┘
```

The dependency direction is strictly **unidirectional and downward**: `rhi` never references `framework`, `framework` never references `passes`, and passes never reference each other. This is enforced at the CMake level through static library targets — `himalaya_rhi`, `himalaya_framework`, `himalaya_passes`, and `himalaya_app` — where each target only links against the layer directly below it.

| Namespace | CMake Target | Allowed Dependencies |
|---|---|---|
| `himalaya::rhi` | `himalaya_rhi` | Vulkan, VMA, spdlog, GLFW, shaderc, GLM |
| `himalaya::framework` | `himalaya_framework` | `himalaya_rhi` + third-party |
| `himalaya::passes` | `himalaya_passes` | `himalaya_framework` + `himalaya_rhi` |
| `himalaya::app` | `himalaya_app` (executable) | All above + third-party |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L111-L119), [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11), [rhi/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/rhi/CMakeLists.txt#L1-L24)

## File Organization

### Include Paths

All header files use **project-prefixed include paths** rooted at the `include/` directory of each layer. The path mirrors the namespace hierarchy:

```cpp
#include <himalaya/rhi/context.h>           // Layer 0
#include <himalaya/rhi/resources.h>         // Layer 0
#include <himalaya/framework/render_graph.h> // Layer 1
#include <himalaya/passes/forward_pass.h>    // Layer 2
#include <himalaya/app/renderer.h>           // Layer 3
```

This convention makes the layer of any included header immediately apparent from the path, and ensures that headers from different layers never collide in the include space.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L75-L78)

### Header and Source Pairing

Each layer follows a consistent `include/` + `src/` split:

| Layer | Header Root | Source Root |
|---|---|---|
| `rhi/` | `rhi/include/himalaya/rhi/` | `rhi/src/` |
| `framework/` | `framework/include/himalaya/framework/` | `framework/src/` |
| `passes/` | `passes/include/himalaya/passes/` | `passes/src/` |
| `app/` | `app/include/himalaya/app/` | `app/src/` |

Header files declare interfaces (types, classes, free functions). Source files (`.cpp`) implement them. The naming is 1:1: `render_graph.h` pairs with `render_graph.cpp`, `forward_pass.h` with `forward_pass.cpp`.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L126-L149)

### Include Guards

All C++ headers use `#pragma once` — never traditional `#ifndef` guards. This is a deliberate project-wide rule with no exceptions:

```cpp
#pragma once

/**
 * @file context.h
 * @brief Vulkan context: instance, device, queues, and memory allocator.
 */
```

GLSL shared headers use `#ifndef` / `#define` / `#endif` guards with a `SCREAMING_GLSL` naming convention, because GLSL does not support `#pragma once`:

```glsl
#ifndef BRDF_GLSL
#define BRDF_GLSL
// ... contents ...
#endif // BRDF_GLSL
```

Sources: [rhi/include/himalaya/rhi/context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L1), [shaders/common/brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L14-L16)

## Documentation Standards

### Doxygen Format

All public and private APIs, structs, fields, and enum values are documented using **Javadoc-style Doxygen** (`/** */`). The documentation language is **English** throughout. The project enforces a clear separation of concerns between header and source documentation:

| Location | Documents | Content Focus |
|---|---|---|
| `.h` files | Interface contracts | **What**: purpose, semantics, constraints, preconditions |
| `.cpp` files | Implementation details | **Why/How**: algorithm explanation, design rationale |
| Header-only (`.h` only) | Both aspects | Combined **what** and **why** in the header |
| Source-only (`.cpp` only, e.g. `main.cpp`) | Both aspects | Combined **what** and **why** in the source |

Every file begins with a `@file` / `@brief` header that describes the file's module membership — not transient feature descriptions that would become stale:

```cpp
/**
 * @file resources.h
 * @brief GPU resource management: buffers, images, and resource pool.
 */
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L80-L88), [rhi/include/himalaya/rhi/resources.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/resources.h#L1-L6)

### Field Documentation

Every struct field, class member, and enum value carries a `/** @brief */` comment. For structs with complex layout requirements (e.g., GPU data that must match shader-side `std430`), byte offsets are annotated inline:

```cpp
struct alignas(16) GPUMaterialData {
    glm::vec4 base_color_factor;  ///< offset  0 — glTF baseColorFactor (RGBA)
    glm::vec4 emissive_factor;    ///< offset 16 — xyz = emissiveFactor, w unused
    float metallic_factor;        ///< offset 32 — glTF metallicFactor
    float roughness_factor;       ///< offset 36 — glTF roughnessFactor
    // ...
    uint32_t _padding;            ///< offset 76 — padding to 80 bytes
};

static_assert(sizeof(GPUMaterialData) == 80, "GPUMaterialData must be 80 bytes (std430)");
```

Layout-critical structs use `static_assert` to enforce size constraints at compile time. Padding fields are named `_padding` with a lowercase underscore prefix.

Sources: [framework/include/himalaya/framework/material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L39-L59), [shaders/common/bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L36-L54)

## Lifetime Management Pattern

The project uses an **explicit init/destroy** lifecycle — never constructors and destructors for GPU resources. Every resource-owning class exposes `init()` and `destroy()` methods:

```cpp
class ResourceManager {
public:
    void init(Context *context);
    void destroy();
    // ... resource operations ...
};

class ForwardPass {
public:
    void setup(rhi::Context &ctx, ...);  // Pass classes use "setup" instead of "init"
    void destroy() const;
    // ...
};
```

This pattern is deliberate: Vulkan resource destruction must happen in a specific order (reverse creation), and RAII destructors fire in an order determined by C++ scope rules, which can easily violate Vulkan's ordering requirements. Explicit `destroy()` calls give the application full control over teardown sequence.

Sources: [rhi/include/himalaya/rhi/resources.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/resources.h#L266-L280), [passes/include/himalaya/passes/forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L46-L81), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L164-L166)

## Handle-Based Resource Pattern

GPU resources are accessed through **generation-based handles** — lightweight value types carrying a slot index and a generation counter. This pattern provides use-after-free detection without runtime overhead:

```cpp
struct ImageHandle {
    uint32_t index = UINT32_MAX;     // Slot in the resource pool
    uint32_t generation = 0;         // Incremented on destruction
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
    bool operator==(const ImageHandle &) const = default;
};
```

The convention is consistent across all resource types: `ImageHandle`, `BufferHandle`, `SamplerHandle`, and `BindlessIndex` all follow the same `{index, generation, valid()}` pattern. Invalid handles default to `UINT32_MAX`.

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L23-L73)

## Control Flow and Braces

All control flow bodies — `if`, `else`, `for`, `while` — **must use braces `{}`** even when the body is a single statement. Omitting braces is prohibited:

```cpp
// ✓ Correct
if (img.allocation != VK_NULL_HANDLE) {
    vmaDestroyImage(context_->allocator, img.image, img.allocation);
}

// ✗ Prohibited
if (img.allocation != VK_NULL_HANDLE)
    vmaDestroyImage(context_->allocator, img.image, img.allocation);
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L90-L91)

## Enum and Flag Design

### Scoped Enums

All enums use `enum class` with an explicit underlying type (typically `uint32_t`). Values are PascalCase:

```cpp
enum class Format : uint32_t {
    Undefined,
    R8G8B8A8Unorm,
    R8G8B8A8Srgb,
    D32Sfloat,
    // ...
};
```

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L94-L131)

### Bitmask Flags

Bitmask-style enums use `1 << n` values with manually defined bitwise operators and a `has_flag()` free function:

```cpp
enum class BufferUsage : uint32_t {
    VertexBuffer      = 1 << 0,
    IndexBuffer       = 1 << 1,
    UniformBuffer     = 1 << 2,
    StorageBuffer     = 1 << 3,
    // ...
};

inline BufferUsage operator|(BufferUsage a, BufferUsage b) { /* ... */ }
inline bool has_flag(BufferUsage flags, BufferUsage bit) { /* ... */ }
```

This pattern is consistent across `BufferUsage`, `ImageUsage`, and any other flag-type enum in the codebase.

Sources: [rhi/include/himalaya/rhi/resources.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/resources.h#L22-L51)

## Error Handling

Vulkan errors are treated as **programming errors** — not runtime conditions to recover from. The `VK_CHECK` macro validates every `VkResult`, logs the failure via `spdlog::critical`, and calls `std::abort()`:

```cpp
#define VK_CHECK(x)                                                     \
    do {                                                                \
        VkResult vk_check_result_ = (x);                                \
        if (vk_check_result_ != VK_SUCCESS) {                           \
            spdlog::critical("VK_CHECK failed: {} returned {} at {}:{}", \
                             #x, static_cast<int>(vk_check_result_),    \
                             __FILE__, __LINE__);                       \
            std::abort();                                               \
        }                                                               \
    } while (0)
```

Validation layers and `VK_EXT_debug_utils` are enabled in all build configurations, not just debug. There is no "release mode without validation" in this project.

Sources: [rhi/include/himalaya/rhi/context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L19-L37), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L167)

## [[nodiscard]] Policy

Functions that return a value the caller must use are annotated with `[[nodiscard]]`. This applies to all factory functions (which return handles), query functions (which return data), and conversion utilities:

```cpp
[[nodiscard]] BufferHandle create_buffer(const BufferDesc &desc, const char *debug_name);
[[nodiscard]] const Buffer &get_buffer(BufferHandle handle) const;
[[nodiscard]] VkDeviceAddress get_buffer_device_address(BufferHandle handle) const;
[[nodiscard]] VkFormat to_vk_format(const Format format);
```

Sources: [rhi/include/himalaya/rhi/resources.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/resources.h#L289-L312), [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L186-L212)

## Commit Conventions

Changes are committed using **Conventional Commits** format: `<type>(<scope>): <description>`.

| Type | Purpose |
|---|---|
| `feat` | New feature or new code |
| `docs` | Documentation changes |
| `chore` | Build configuration, toolchain, maintenance |
| `fix` | Bug fix |
| `refactor` | Refactoring without behavior change |

Common scopes include `rhi`, `app`, `framework`, `passes`, and `shaders`. Code and documentation changes must be committed separately — never mixed in the same commit.

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L57-L69)

## Convention Quick Reference

The following table serves as a rapid lookup when writing or reviewing code:

| Question | Answer |
|---|---|
| How do I name a new class? | `PascalCase` — e.g., `ShadowMapper` |
| How do I name a new method? | `snake_case` — e.g., `compute_cascades()` |
| How do I name a private field? | `snake_case_` with trailing underscore — e.g., `cascade_data_` |
| How do I name a constant? | `kPascalCase` — e.g., `kMaxCascades` |
| How do I name a new enum value? | `PascalCase` within `enum class` — e.g., `Format::R16G16Sfloat` |
| How do I name a new shader file? | `snake_case.stage` — e.g., `bloom.comp` |
| Include guard in C++? | `#pragma once` — always |
| Include guard in GLSL? | `#ifndef NAME_GLSL` / `#define NAME_GLSL` / `#endif` |
| Braces on single-line `if`? | **Always required** |
| Object lifetime? | Explicit `init()` / `destroy()` — no RAII for GPU objects |
| Vulkan error handling? | `VK_CHECK()` macro — abort on failure |
| Documentation location? | `.h` = what/semantics, `.cpp` = why/how |
| Documentation language? | English |
| Documentation format? | Javadoc-style Doxygen `/** */` |
| GPU struct padding field? | `_padding` with `static_assert` on size |
| Which namespace for a new RHI type? | `himalaya::rhi` |
| Which namespace for a new render pass? | `himalaya::passes` |

## Next Steps

Now that you understand the naming rules and coding patterns, explore how these conventions manifest in the actual architecture:

- **[Project Structure and Layered Architecture](https://github.com/1PercentSync/himalaya/blob/main/4-project-structure-and-layered-architecture)** — see how the four namespaces map to build targets, directory layout, and dependency boundaries
- **[GPU Context Lifecycle — Instance, Device, Queues, and Memory](https://github.com/1PercentSync/himalaya/blob/main/5-gpu-context-lifecycle-instance-device-queues-and-memory)** — examine how `init()/destroy()` and generation-based handles work in the lowest layer
- **[Resource Management — Generation-Based Handles, Buffers, Images, and Samplers](https://github.com/1PercentSync/himalaya/blob/main/6-resource-management-generation-based-handles-buffers-images-and-samplers)** — deep dive into the handle pattern and its safety guarantees
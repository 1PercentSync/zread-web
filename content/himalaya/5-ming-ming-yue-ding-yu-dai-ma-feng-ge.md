本页面为 Himalaya 渲染器项目的编码规范参考。遵循一致的命名约定和代码风格是团队协作的基础，也能让代码库保持良好的可维护性。本文档涵盖 C++ 代码和 GLSL 着色器的命名规则、格式化规范以及文档注释标准。

## 命名约定总览

Himalaya 采用清晰一致的命名体系，通过命名风格即可直观识别代码元素的类型和作用域。所有命名遵循单一职责原则：看到名字就能知道它是什么。

| 元素类型 | 命名风格 | 示例 |
|---------|---------|------|
| 类 / 结构体 | `PascalCase` | `RenderGraph`, `ImageHandle`, `Vertex` |
| 方法 / 自由函数 | `snake_case` | `create_image()`, `update_view()` |
| 私有成员变量 | `snake_case` + 后缀 `_` | `device_`, `allocator_`, `deletors_` |
| 公有成员 / 局部变量 | `snake_case` | `width`, `format`, `vertex_count` |
| 命名空间 | `snake_case` | `himalaya::rhi`, `himalaya::framework` |
| 枚举类 | `PascalCase` | `ShaderStage`, `Format`, `BufferUsage` |
| 枚举值 (scoped) | `PascalCase` | `ShaderStage::Vertex`, `Format::R8G8B8A8Unorm` |
| 编译期常量 | `kPascalCase` | `kMaxFramesInFlight` |
| 宏 / 宏函数 | `SCREAMING_CASE` | `VK_CHECK()`, `FEATURE_SHADOWS` |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L98-L109), [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L78-L86), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L39-L41)

### 实际代码示例

**类与结构体命名** —— 使用 PascalCase 表示类型：

```cpp
struct ImageHandle {
    uint32_t index = UINT32_MAX;
    uint32_t generation = 0;
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
};

class Context {
public:
    void init(GLFWwindow* window);
    void destroy();
    
private:
    VkDevice device_ = VK_NULL_HANDLE;  // 私有成员后缀 _
    VmaAllocator allocator_ = nullptr;
};
```

Sources: [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L23-L34), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L112-L123)

**函数命名** —— 方法使用 snake_case，清晰表达操作：

```cpp
void update_view();           // 更新视图矩阵
void update_projection();     // 更新投影矩阵
void update_view_projection(); // 更新组合矩阵

// RHI 资源操作
BufferHandle create_buffer(const BufferDesc& desc);
void destroy_buffer(BufferHandle handle);
```

Sources: [camera.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/camera.h#L69-L88)

**私有成员标识** —— 后缀下划线清晰区分成员与局部变量：

```cpp
struct DeletionQueue {
    void push(std::function<void()>&& fn) { 
        deletors_.push_back(std::move(fn));  // 成员 vs 参数
    }
    
private:
    std::vector<std::function<void()>> deletors_;  // 后缀 _
};
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L64-L80)

## 命名空间架构

Himalaya 采用四层架构设计，每层对应一个命名空间，实现编译期依赖隔离：

| 命名空间 | 架构层 | 职责 |
|---------|--------|------|
| `himalaya::rhi` | Layer 0 — Vulkan 抽象层 | GPU 资源管理、命令录制、管线状态 |
| `himalaya::framework` | Layer 1 — 渲染框架层 | 场景数据、材质系统、Render Graph |
| `himalaya::passes` | Layer 2 — 渲染 Pass 层 | 具体渲染效果实现 |
| `himalaya::app` | Layer 3 — 应用层 | 场景加载、交互逻辑、主循环 |

依赖方向强制单向：`rhi` ← `framework` ← `passes` ← `app`。低层命名空间绝不引用高层，保证架构边界清晰。

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L111-L118), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L39), [mesh.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/mesh.h#L16)

## 枚举定义规范

使用 `enum class` 强类型枚举，枚举名和枚举值均采用 PascalCase，避免命名冲突：

```cpp
// 资源格式枚举 —— 值名体现格式特征
enum class Format : uint32_t {
    Undefined,
    
    // 8-bit 通道
    R8Unorm,
    R8G8Unorm,
    R8G8B8A8Unorm,
    R8G8B8A8Srgb,    // Srgb 后缀区分颜色空间
    
    // HDR 格式
    R16Sfloat,
    R16G16B16A16Sfloat,
    B10G11R11UfloatPack32,  // Pack32 后缀表示打包格式
    
    // 块压缩
    Bc7UnormBlock,   // Block 后缀表示块压缩
    Bc7SrgbBlock,
};

// 着色器阶段 —— 简洁清晰
enum class ShaderStage : uint32_t {
    Vertex,
    Fragment,
    Compute,
    RayGen,
    ClosestHit,
    AnyHit,
    Miss,
};
```

Sources: [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L94-L131), [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L78-L86)

## 常量与宏定义

**编译期常量** —— 使用 `kPascalCase` 前缀，表示 "constant"：

```cpp
constexpr uint32_t kMaxFramesInFlight = 2;  // 帧并行数
constexpr uint32_t kMaxBindlessTextures = 4096;  // Bindless 上限
```

**宏定义** —— 仅用于条件编译和必要的代码生成，SCREAMING_CASE 全大写：

```cpp
// 功能开关宏（着色器侧）
#define FEATURE_SHADOWS         (1u << 0)
#define FEATURE_AO              (1u << 1)
#define FEATURE_CONTACT_SHADOWS (1u << 2)

// 调试模式常量
#define DEBUG_MODE_FULL_PBR          0
#define DEBUG_MODE_NORMAL            4
#define DEBUG_MODE_METALLIC          5
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L41), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L58-L84)

## 头文件规范

**头文件保护** —— 统一使用 `#pragma once`，简洁且避免宏命名冲突：

```cpp
#pragma once  // 替代 #ifndef/#define/#endif 三件套
```

**包含路径** —— 使用带项目前缀的尖括号路径，区分系统头与项目头：

```cpp
#include <himalaya/rhi/types.h>        // 项目内部
#include <himalaya/framework/mesh.h>  // 跨层引用

#include <vulkan/vulkan.h>   // 第三方库
#include <glm/glm.hpp>       // 数学库
#include <spdlog/spdlog.h>   // 日志库
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L1-L16), [mesh.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/mesh.h#L1-L15)

## 文档注释规范

采用 **Javadoc 风格 Doxygen** 注释（`/** */`），语言为英文。文档分布遵循 "什么在头文件，为什么在源文件" 原则：

| 文件类型 | 文档内容 | 侧重点 |
|---------|---------|--------|
| `.h` 头文件 | 接口文档 | **What**：做什么、语义、约束、参数说明 |
| `.cpp` 源文件 | 实现注释 | **Why/How**：为什么这么做、算法解释 |

**文件头文档** —— 使用 `@file` 标记，只写静态信息（文件名、所属模块），不写会过时的功能描述：

```cpp
/**
 * @file context.h
 * @brief Vulkan context: instance, device, queues, and memory allocator.
 */
```

**结构体/类文档** —— 描述职责和设计意图：

```cpp
/**
 * @brief Per-frame GPU synchronization and command recording resources.
 *
 * Each in-flight frame owns an independent set of these objects
 * so the CPU can record frame N+1 while the GPU is still executing frame N.
 */
struct FrameData {
    /** @brief Command pool for this frame's command buffer allocation. */
    VkCommandPool command_pool = VK_NULL_HANDLE;
    
    /** @brief Primary command buffer recorded each frame. */
    VkCommandBuffer command_buffer = VK_NULL_HANDLE;
};
```

**函数文档** —— 使用 `@brief` 简述，`@param` 说明参数：

```cpp
/**
 * @brief Initializes the entire Vulkan context.
 * @param window GLFW window used to create the Vulkan surface.
 */
void init(GLFWwindow* window);

/**
 * @brief Computes a camera position that frames the given AABB.
 * 
 * Uses current yaw, pitch, and fov to calculate the distance needed
 * to fit the AABB's bounding sphere in view. Does not modify camera state.
 * @return Current position unchanged if the AABB is degenerate.
 */
[[nodiscard]] glm::vec3 compute_focus_position(const AABB& bounds) const;
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L1-L6), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L82-L103), [camera.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/camera.h#L14-L26)

## 控制流规范

**强制花括号** —— `if`、`else`、`for`、`while` 等语句体即使只有一行也必须使用 `{}`，杜绝缩进错误引发的逻辑漏洞：

```cpp
// 正确
if (vk_check_result_ != VK_SUCCESS) {
    spdlog::critical("VK_CHECK failed: {} returned {}", ...);
    std::abort();
}

// 错误 —— 即使一行也禁止省略花括号
if (condition) do_something();  // 禁止！
```

**VK_CHECK 宏** —— Vulkan 调用错误检查，失败时输出诊断信息并中止：

```cpp
#define VK_CHECK(x)                                                     \
    do {                                                                \
        VkResult vk_check_result_ = (x);                                \
        if (vk_check_result_ != VK_SUCCESS) {                             \
            spdlog::critical("VK_CHECK failed: {} returned {} at {}:{}", \
                             #x,                                        \
                             static_cast<int>(vk_check_result_),        \
                             __FILE__,                                  \
                             __LINE__);                                 \
            std::abort();                                               \
        }                                                               \
    } while (0)
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L89-L91), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L26-L37)

## GLSL 着色器规范

**版本与扩展** —— 统一使用 Vulkan 1.4 兼容的 GLSL 版本：

```glsl
#version 460
#extension GL_EXT_ray_tracing : require  // 条件扩展
```

**文件文档** —— 与 C++ 相同的 Javadoc 风格：

```glsl
/**
 * @file forward.vert
 * @brief Forward pass vertex shader.
 *
 * Transforms vertices by model and view-projection matrices.
 * Outputs world-space position, normal, tangent, and texture coordinates
 * for the fragment shader.
 *
 * Uses `invariant gl_Position` to guarantee bit-identical depth values
 * with depth_prepass.vert, enabling EQUAL depth test for zero-overdraw.
 */
```

**变量命名** —— 采用 GLSL 惯例：
- `snake_case` 用于函数名和局部变量：`frag_world_pos`, `normal_matrix`
- 输入前缀 `in_`：`in_position`, `in_normal`, `in_uv0`
- 输出前缀 `frag_`（片段着色器输入）：`frag_world_pos`, `frag_normal`

**宏常量** —— SCREAMING_CASE 表示常量和特性开关：

```glsl
#define MAX_SHADOW_CASCADES 4

// 功能特性位掩码
#define FEATURE_SHADOWS         (1u << 0)
#define FEATURE_AO              (1u << 1)

// 调试渲染模式
#define DEBUG_MODE_FULL_PBR     0
#define DEBUG_MODE_NORMAL       4
```

Sources: [forward.vert](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.vert#L1-L14), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L70)

## 日志规范

**语义化日志级别** —— 按实际语义选择级别，不为了迁就当前 `kLogLevel` 而提升级别。`kLogLevel` 仅控制运行时过滤，需要更多信息时调整它即可：

```cpp
// 正确 —— error 就是 error，不因 kLogLevel 而降级为 warn
spdlog::error("Failed to load texture: {}", path);

// 正确 —— 开发期断言失败用 critical，立即中止
spdlog::critical("VK_CHECK failed: {} returned {}", ...);
std::abort();
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L93-L96)

## 延伸阅读

掌握命名约定后，建议继续了解以下相关规范：

- [文档注释规范](https://github.com/1PercentSync/himalaya/blob/main/6-wen-dang-zhu-shi-gui-fan) —— 更详细的 Doxygen 注释示例和最佳实践
- [着色器规范与编译流程](https://github.com/1PercentSync/himalaya/blob/main/34-zhao-se-qi-gui-fan-yu-bian-yi-liu-cheng) —— GLSL 完整规范和热重载工作流
- [四层架构设计](https://github.com/1PercentSync/himalaya/blob/main/7-si-ceng-jia-gou-she-ji) —— 理解命名空间背后的架构分层原则

## 快速参考卡

```cpp
#pragma once
#include <himalaya/rhi/types.h>  // 项目头格式

namespace himalaya::framework {   // snake_case 命名空间

constexpr uint32_t kMaxCount = 100;  // kPascalCase 常量

// PascalCase 类名，Javadoc 文档
class MyClass {
public:
    void public_method();      // snake_case 公开方法
    
private:
    int private_member_;       // snake_case_ 私有成员
};

enum class MyEnum {            // PascalCase 枚举类
    FirstValue,               // PascalCase 枚举值
    SecondValue,
};

} // namespace himalaya::framework

// SCREAMING_CASE 宏（谨慎使用）
#define MY_MACRO(x) ((x) * 2)
```
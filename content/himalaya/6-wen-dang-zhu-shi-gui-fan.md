本文档定义了 Himalaya 渲染引擎的代码注释标准，旨在建立统一的文档风格，确保代码可维护性和协作效率。所有新代码应遵循本规范，现有代码在重构时逐步迁移至本规范。

## 文件头注释

每个头文件（`.h`）和源文件（`.cpp`）必须在开头包含文件级文档注释，使用 Doxygen 风格的 `@file` 和 `@brief` 标签。

```cpp
#pragma once

/**
 * @file render_graph.h
 * @brief Render Graph for automatic barrier insertion and pass orchestration.
 */
```

文件头注释应说明文件的主要职责，避免过于笼统的描述。对于复杂模块，可在 `@brief` 后添加详细说明段落。

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L5)

## 类型注释

### 类与结构体

类和结构体的文档应包含 `@brief` 描述核心功能，必要时添加详细设计说明。文档应放在声明之前。

```cpp
/**
 * @brief Frame-level render graph that orchestrates passes and inserts barriers.
 *
 * The graph is rebuilt every frame: clear() → import resources → add passes →
 * compile() → execute(). All resources are externally created and imported via
 * import_image() / import_buffer(); the graph does not create or own GPU resources.
 *
 * compile() computes image layout transitions between passes based on declared
 * resource usage. execute() runs passes in registration order, inserting barriers
 * and debug labels automatically.
 */
class RenderGraph {
```

对于涉及复杂算法或设计决策的类型，文档应解释**为什么**这样设计，而非仅描述**是什么**。

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L155-L173)

### 枚举类型

枚举类型使用 `@brief` 描述整体用途，各枚举值使用行尾注释 `///<` 简洁说明含义。

```cpp
/** @brief Sizing mode for managed render graph images. */
enum class RGSizeMode : uint8_t {
    /**
     * @brief Size is a fraction of the reference resolution.
     *
     * The actual pixel dimensions are computed as
     * (reference_width * width_scale, reference_height * height_scale).
     * Used for screen-sized render targets (depth, HDR color, MSAA buffers).
     */
    Relative,

    /** @brief Size is a fixed pixel dimension. Used for resolution-independent resources. */
    Absolute,
};
```

简单枚举值可用单行注释，复杂枚举值（如 `Relative`）可展开为多行详细说明。

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L35-L52)

## 成员注释

### 成员变量

所有成员变量使用 `/** @brief ... */` 格式注释，说明其用途和语义。文档置于声明之前。

```cpp
/** @brief Vulkan context: instance, device, queues, allocator. */
rhi::Context context_{};

/** @brief Swapchain: presentation surface, images, and image views. */
rhi::Swapchain swapchain_{};

/** @brief GPU resource pool: buffers, images, and samplers. */
rhi::ResourceManager resource_manager_{};
```

对于配置参数或性能敏感的数据，应额外说明默认值的设计依据或性能影响。

Sources: [application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L58-L74)

### 函数与方法

函数文档使用 `@brief` 描述功能，`@param` 描述参数，`@return`（如适用）描述返回值。公共接口需要完整文档，私有方法可简化。

```cpp
/**
 * @brief Initializes the entire Vulkan context.
 * @param window GLFW window used to create the Vulkan surface.
 */
void init(GLFWwindow *window);

/**
 * @brief Destroys all Vulkan objects in reverse creation order.
 */
void destroy();
```

多参数函数需为每个参数提供清晰说明，包括约束条件或有效值范围。

```cpp
/**
 * @brief One-time initialization: compile shaders, create pipeline, store service pointers.
 *
 * @param ctx          Vulkan context.
 * @param rm           Resource manager for buffer/image access.
 * @param dm           Descriptor manager for set binding.
 * @param sc           Shader compiler for GLSL → SPIR-V.
 * @param sample_count MSAA sample count (1 = no MSAA).
 */
void setup(rhi::Context &ctx,
           rhi::ResourceManager &rm,
           rhi::DescriptorManager &dm,
           rhi::ShaderCompiler &sc,
           uint32_t sample_count);
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L165-L185), [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L45-L55)

## 文档组织原则

### 分层注释策略

| 层级 | 注释密度 | 重点内容 |
|------|----------|----------|
| 公共 API（RHI/框架层） | 高 | 完整 `@brief` + 详细说明 + 参数/返回值 |
| 内部实现（Pass层） | 中 | `@brief` + 关键设计决策 |
| 工具函数/辅助类型 | 低 | 简洁 `@brief` 或行尾注释 |

### 注释内容优先级

1. **职责说明**：该类型/函数的核心职责是什么
2. **契约说明**：前置条件、后置条件、不变量
3. **设计依据**：为什么选择这种实现方式
4. **使用示例**（如需要）：复杂 API 的调用模式

### 避免过度文档

以下情况**不需要**额外文档：
- 函数名已完全自描述（如 `valid()` 返回句柄是否有效）
- 标准设计模式的实现（如 RAII 资源包装器）
- 纯数据聚合结构（如 POD 类型）

## 特殊场景处理

### GPU-CPU 数据契约

当定义着色器绑定的 C++ 结构体时，文档必须注明与着色器的对应关系。

```cpp
/**
 * @brief Scene data structures: the contract between application and renderer.
 *
 * Pure header — no .cpp. Application layer fills these structures, renderer
 * consumes them read-only. Also defines GPU-side data layouts that must match
 * the shader bindings in shaders/common/bindings.glsl.
 */
```

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L1-L10)

### 时序与生命周期注释

对于涉及帧同步或资源生命周期的成员，应明确说明时序约束。

```cpp
/**
 * @brief Previous frame's transform (M2+ motion vectors, unused in M1).
 */
glm::mat4 prev_transform{1.0f};

/**
 * @brief Whether ao_filtered history content is valid (false on first frame / resize).
 */
bool ao_history_valid = false;
```

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L64-L65), [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L137-L138)

## 格式规范

| 元素 | 格式 |
|------|------|
| 文件头 | `/** @file filename.ext \n * @brief ... */` |
| 类型/函数 | `/** @brief 单行描述 */` 或展开多行 |
| 详细说明 | 在 `@brief` 后空一行，再添加段落 |
| 参数 | `@param name 描述（首字母小写，句尾无句号）` |
| 枚举值 | `///< 行尾注释` |
| 成员变量 | `/** @brief 描述 */` |

## 延伸阅读

- [命名约定与代码风格](https://github.com/1PercentSync/himalaya/blob/main/5-ming-ming-yue-ding-yu-dai-ma-feng-ge)：代码格式与命名规范
- [RHI层 - Vulkan抽象层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng)：公共 API 文档示例
- [渲染框架层 - 资源与图管理](https://github.com/1PercentSync/himalaya/blob/main/9-xuan-ran-kuang-jia-ceng-zi-yuan-yu-tu-guan-li)：框架层文档示例
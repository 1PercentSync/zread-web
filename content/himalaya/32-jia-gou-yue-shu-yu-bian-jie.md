Himalaya渲染器的架构约束是确保系统长期健康发展的核心机制。这些约束不是技术限制，而是经过深思熟虑的设计边界——它们保护架构的关键属性不被渐进开发过程中的临时妥协侵蚀。本文档详细阐述四层架构的依赖边界、层间通信规则、关键架构约束及其例外情况，以及材质系统和描述符管理的边界约定。

## 四层架构的依赖边界

Himalaya采用**严格单向依赖**的四层架构。这种分层不是组织结构上的选择，而是编译期强制执行的技术约束——每层独立的CMake静态库通过`target_link_libraries`声明依赖关系，任何反向依赖都会导致链接错误。

Sources: [CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/CMakeLists.txt#L1-L11)

### 依赖链与命名空间

| 层级 | CMake Target | 命名空间 | 依赖目标 |
|------|--------------|----------|----------|
| Layer 0 | `himalaya_rhi` | `himalaya::rhi` | 无（Vulkan核心） |
| Layer 1 | `himalaya_framework` | `himalaya::framework` | `himalaya_rhi` |
| Layer 2 | `himalaya_passes` | `himalaya::passes` | `himalaya_framework` |
| Layer 3 | `himalaya_app` | `himalaya::app` | 全部上层 |

Sources: [rhi/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/rhi/CMakeLists.txt#L1-L24), [framework/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/framework/CMakeLists.txt#L1-L44), [passes/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/passes/CMakeLists.txt#L1-L19), [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L1-L39)

### 禁止反向依赖

以下依赖关系被**严格禁止**：
- RHI层不得引用Framework层代码
- Framework层不得引用Passes层代码  
- Passes层各Pass之间不得互相引用

这种禁止是**构建时强制执行**的——CMake的target_link_libraries确保只有正向依赖链存在。Layer 2的各Pass之间也没有直接依赖，只通过Layer 1的Render Graph间接关联。

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L114-L136)

## 层间通信规则与数据边界

### 句柄抽象边界

RHI层通过**Generation-based资源句柄**向上层暴露资源，而非原始Vulkan句柄。这提供了两重保护：
1. **内存安全**：句柄包含index + generation，检测到释放后重用（use-after-free）
2. **实现封装**：上层不直接持有VkImage/VkBuffer，RHI层保留资源管理的自由度

```cpp
struct ImageHandle {
    uint32_t index = UINT32_MAX;      // 资源池槽位索引
    uint32_t generation = 0;          // 代际计数器，检测use-after-free
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
};
```

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L22-L35)

### Pass通信的唯一通道

Pass之间**不直接互相调用或引用**。数据传递完全通过Render Graph的资源声明进行。这种设计保护的核心属性是**Pass可插拔性**——添加或移除一个Pass不需要修改其他Pass的代码。

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L115-L125)

### 渲染列表不可变性

渲染器接收的"渲染视图"（一组mesh实例、光源、探针、相机参数）在**帧内不可变**。剔除结果是独立的索引列表，不从渲染列表中删除物体。这一约束保护：
- **多视图复用**：CSM各cascade、Reflection Probes、VR双眼都能复用同一份场景数据
- **数据安全**：避免在渲染过程中修改正在被读取的数据

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L85-L95)

## 上层代码的Vulkan类型约束

### 核心约束

上层代码（Framework层及以上）**不直接出现VkImage、VkBuffer等Vulkan类型**，通过句柄和自定义枚举操作。这保护了Layer 0的内部实现自由度——RHI层可以在不破坏上层代码的前提下重构Vulkan资源管理策略。

### 明确的例外情况

以下Framework层组件允许直接使用Vulkan类型，不受上述约束限制：

| 组件 | 允许使用的Vulkan类型 | 理由 |
|------|---------------------|------|
| Render Graph | `VkImageLayout`、`VkPipelineStageFlags2` | 本质是Vulkan barrier管理器，使用原生枚举比自造再映射更直观且不易出错 |
| ImGui Backend | `VkCommandBuffer`、`VkImage`等 | 第三方库的Vulkan backend天然需要Vulkan类型 |
| Vertex管线描述 | `VkVertexInputBindingDescription`、`VkVertexInputAttributeDescription` | 仅用于Pipeline创建，再包一层自定义类型纯增复杂度 |
| `upload_image` dst_stage | `VkPipelineStageFlags2` | 同步原语，与Render Graph使用VkImageLayout属同一范畴，bitmask封装成本高 |

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L140-L157)

## 材质系统的分层边界

### GPU材质数据结构

材质系统定义**GPU端与CPU端严格一一对应**的数据结构：

```cpp
struct alignas(16) GPUMaterialData {
    glm::vec4 base_color_factor;      // offset 0
    glm::vec4 emissive_factor;        // offset 16
    float metallic_factor;             // offset 32
    float roughness_factor;          // offset 36
    // ... std430布局，80字节固定
};
static_assert(sizeof(GPUMaterialData) == 80, "GPUMaterialData must be 80 bytes");
```

这种固定布局的约束保护了**Shader数据一致性**——shader端必须在编译时知道struct布局，因此不引入运行时参数描述系统。

Sources: [framework/include/himalaya/framework/material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L39-L81)

### 材质三层架构边界

材质系统内部也有清晰的分层：
- **材质模板/着色模型**：定义着色方式（标准PBR、卡通渲染等），对应一组shader变体
- **材质实例**：基于模板设置具体参数，运行时大量物体共享同一模板
- **Shader变体管理**：编译时开关（法线贴图、POM、阴影接收等）的编译和缓存

添加新着色模型时，仅需要新增对应的数据结构和shader变体，不触及现有材质实例的管理逻辑。

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L53-L70)

## 描述符管理与Bindless边界

### 描述符集分层策略

Himalaya采用**Set 0传统Descriptor Set + Set 1传统Descriptor Set（Bindless纹理）**的双层策略：

| Set | 用途 | 绑定内容 |
|-----|------|----------|
| Set 0 | 全局数据 | Global UBO、实例SSBO、材质SSBO |
| Set 1 | Bindless纹理 | 所有纹理的全局descriptor array |
| Set 2 | 帧资源 | Depth、Normal、HDR Color等屏幕尺寸资源 |
| Set 3 | Pass私有 | Compute Pass的storage image等 |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L149-L156)

### Bindless索引边界

纹理通过`BindlessIndex`访问全局纹理数组，而非硬编码的binding point：

```cpp
struct BindlessIndex {
    uint32_t index = UINT32_MAX;  // Set 1, Binding 0的数组索引
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
};
```

这种设计保护了**材质系统灵活性**——Instancing、Shadow Atlas等动态纹理访问可以无缝支持，不需要预先规划descriptor布局。

Sources: [rhi/include/himalaya/rhi/types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L58-L66)

## Render Graph资源管理边界

### 资源所有权边界

根据资源是否需要跟随屏幕尺寸resize，Render Graph采用**两种管理策略**：

| 准则 | 管理方式 | 典型资源 | 创建/销毁职责 |
|------|----------|----------|---------------|
| 需要resize（屏幕尺寸相关） | **RG Managed** | Depth、Normal、HDR Color、AO texture | Render Graph创建、缓存、resize时自动重建 |
| 不需要resize（固定尺寸） | **Pass自管理 + 每帧import_image()** | Shadow map array、Shadow Atlas、Froxel 3D texture | Pass完全拥有生命周期，RG仅管barrier |

RG Managed资源通过`create_managed_image()`创建，Pass自管理资源通过每帧`import_image()`引入图管理。

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L29-L45)

### Temporal资源边界

Temporal资源（需要历史帧数据的资源，如AO history）由Render Graph管理**double buffer和帧间切换**。Pass声明时标记`temporal=true`，系统自动处理：
- 两帧backing image的分配
- 每帧current/history的自动交换
- resize后history失效的标记

```cpp
managed_depth_ = render_graph_.create_managed_image("Depth", desc, true); // temporal=true
// 使用：current = use_managed_image(), history = get_history_image()
```

这一机制保护了**模块启用禁用的干净性**——禁用Pass时其temporal数据自然失效，重新启用时干净积累。

Sources: [framework/include/himalaya/framework/render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L278-L320), [app/src/renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L45-L65)

## 架构约束速查表

| 约束 | 保护的架构属性 | 违反后果 |
|------|---------------|----------|
| 上层不接触Vulkan类型 | Layer 0内部实现自由度 | RHI层重构时需要同步修改上层代码 |
| Pass间只通过资源声明通信 | Pass可插拔性 | 添加/移除Pass需要修改其他Pass代码 |
| 渲染列表帧内不可变 | 多视图复用、数据安全 | 多视图渲染时产生竞态条件或数据不一致 |
| 配置参数单向传递 | 数据流清晰可追踪 | Pass状态泄漏到应用层，形成隐式依赖 |
| Temporal数据归属Pass | 模块启用禁用的干净性 | 禁用Pass后残留历史数据，重新启用时污染 |
| Shader不硬编码绑定 | 材质系统灵活性 | 新增纹理类型时需要修改所有shader |
| Validation Layer常开 | 开发期bug可见性 | 生产环境才发现的GPU同步或资源错误 |

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L160-L172)

## 下一步阅读

理解架构约束后，建议继续阅读：
- [四层架构设计](https://github.com/1PercentSync/himalaya/blob/main/7-si-ceng-jia-gou-she-ji) —— 深入了解各层职责与交互模式
- [RHI层 - Vulkan抽象层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng) —— 探索Layer 0的资源抽象实现
- [Render Graph资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li) —— 详细了解自动屏障与资源生命周期
- [材质系统架构](https://github.com/1PercentSync/himalaya/blob/main/13-cai-zhi-xi-tong-jia-gou) —— 理解GPU材质数据的完整布局
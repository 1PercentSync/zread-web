时域数据管理是现代渲染引擎实现高质量、低噪声图像的核心基础设施。在Himalaya渲染管线中，时域数据涵盖深度缓冲历史、AO（环境光遮蔽）历史缓冲等关键资源，通过重投影机制实现帧间数据复用，配合三层拒绝算法确保稳定性。Temporal Filtering则通过混合当前帧与历史帧数据，显著降低蒙特卡洛积分和屏幕空间效果的空间噪声，同时保持几何边界清晰。

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L56-L73)

## 时域数据资源类型

### 核心时域资源定义

FrameContext中定义的时域资源ID构成了帧间数据传递的接口契约：

| 资源ID | 数据类型 | 用途 | 生命周期 |
|--------|----------|------|----------|
| `depth_prev` | `RGResourceId` | 上一帧解析深度（D32Sfloat） | 每帧交换 |
| `ao_filtered` | `RGResourceId` | 当前帧AO时域滤波输出（RG8/RGBA8） | 单帧 |
| `ao_history` | `RGResourceId` | 上一帧AO滤波结果 | 每帧交换 |
| `ao_history_valid` | `bool` | 历史数据有效性标志 | 动态 |

这些资源在Render Graph的`use_managed`或`import`机制中声明，通过双缓冲机制实现Ping-Pong交换——每帧渲染完成后，`ao_filtered`的内容被复制或引用为下一帧的`ao_history`。

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L59-L72)

### 时域数据流转模式

时域数据遵循**双缓冲交换**模式运作：第N帧渲染时读取`ao_history`（第N-1帧的输出），写入`ao_filtered`；第N帧结束后，通过Render Graph的资源管理，这两个标识符在逻辑上交换角色。这种设计避免了显式的GPU-GPU复制操作，仅通过资源句柄的重新分配实现零开销轮换。

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L68-L72)

## AO时域滤波Pass架构

### Pass职责边界

`AOTemporalPass`位于[渲染Pass层](https://github.com/1PercentSync/himalaya/blob/main/10-xuan-ran-passceng-xiao-guo-shi-xian)，是GTAO管线序列中的第三个Pass（GTAO计算 → [空域降噪](https://github.com/1PercentSync/himalaya/blob/main/22-gtaosuan-fa-shi-xian) → 时域降噪）。其核心职责包括：

1. **重投影计算**：将当前帧像素坐标通过深度值反推世界空间，再投影到上一帧的裁剪空间
2. **三层拒绝验证**：检测几何体移动、遮挡关系变化等导致历史数据失效的场景
3. **时域混合**：对验证通过的历史数据进行加权混合，输出稳定结果

Sources: [ao_temporal_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_temporal_pass.h#L1-L15)

### 资源绑定架构

时域Pass采用**Push Descriptor + Global Sets**的混合绑定策略：

```
Set 0-2: 全局描述符（Camera、Scene、GTAO参数）——通过DescriptorManager预分配
Set 3:   Push Descriptor（每Dispatch动态绑定）——4个绑定点：
  ├─ binding 0: storage image (ao_filtered 输出)
  ├─ binding 1: combined sampler (ao_blurred 输入)
  ├─ binding 2: combined sampler (ao_history 输入)
  └─ binding 3: combined sampler (depth_prev 输入)
Push Constants: temporal_blend混合因子
```

Push Descriptor机制避免了每帧分配DescriptorSet的开销，特别适用于全屏后处理Pass的高频Dispatch场景。

Sources: [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L47-L84)

## 重投影与运动向量

### 重投影管线

时域滤波的核心数学操作是将当前帧的片元坐标重投影到上一帧的UV空间。该管线完整处理Reverse-Z坐标系和Y轴翻转的视口变换：

```glsl
// UV → NDC (Y-flipped viewport compensation)
vec2 ndc = vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);

// Clip → world via inv_view_projection
vec4 world_h = global.inv_view_projection * vec4(ndc, depth, 1.0);
vec3 world_pos = world_h.xyz / world_h.w;

// World → previous frame clip space
vec4 prev_clip = global.prev_view_projection * vec4(world_pos, 1.0);
vec3 prev_ndc = prev_clip.xyz / prev_clip.w;

// NDC → UV (inverse of the forward Y-flip mapping)
vec2 prev_uv = vec2(prev_ndc.x * 0.5 + 0.5, 0.5 - prev_ndc.y * 0.5);
```

Reverse-Z配置下（near=1.0, far=0.0），深度值在NDC空间的分布与通常配置相反，重投影管线通过统一的数学变换正确处理这一约定。Y轴翻转补偿是必要的，因为Vulkan的NDC坐标系Y轴向上为正，而纹理坐标V轴向下为正。

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L51-L67)

## 三层拒绝算法

### 算法设计原则

三层拒绝（Three-Layer Rejection）是防止时域滤波产生鬼影（ghosting）和拖尾（smearing）的关键机制。算法对历史数据执行从粗到细的验证，一旦某层验证失败即立即返回当前帧数据，避免无效计算：

```mermaid
flowchart TD
    A[重投影得到prev_uv<br/>expected_prev_depth] --> B{Layer 1: UV在[0,1]内?}
    B -->|否| C[拒绝: 返回current_ao]
    B -->|是| D{Layer 2: 深度差<br/>&lt; 5%?}
    D -->|否| C
    D -->|是| E[Layer 3: 采样3x3邻域AO<br/>计算min/max范围]
    E --> F[截断history_ao到邻域范围]
    F --> G[返回截断后的history_ao]
```

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L99-L135)

### 第一层：UV有效性检测

最轻量的拒绝条件检测重投影后的UV是否落在上一帧屏幕范围内。摄像机旋转或物体移出视锥会导致此条件触发。实现采用简单的边界比较：

```glsl
if (prev_uv.x < 0.0 || prev_uv.x > 1.0 ||
    prev_uv.y < 0.0 || prev_uv.y > 1.0) {
    rejected = true;
    return current_ao;
}
```

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L104-L109)

### 第二层：深度一致性检测

该层检测几何体在片元位置的遮挡关系是否发生变化（如物体移动导致的遮挡/揭露）。关键在于**线性化深度比较**——原始Reverse-Z深度值在远距离处精度极低，线性化后获得均匀的距离敏感度：

```glsl
float lin_expected = linearize_depth(expected_prev_depth);
float lin_stored = linearize_depth(texture(depth_prev_tex, prev_uv).r);
float depth_diff = abs(lin_expected - lin_stored);

if (depth_diff / max(lin_expected, 1e-4) > DEPTH_REJECT_THRESHOLD) {
    rejected = true;  // DEPTH_REJECT_THRESHOLD = 0.05 (5%)
    return current_ao;
}
```

5%的相对阈值在稳定性和敏感性之间取得平衡：过于宽松会产生鬼影，过于严格会导致静态场景也频繁拒绝历史数据。

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L111-L118)

### 第三层：邻域截断

即使通过深度验证，历史数据仍可能包含过时的高频细节。邻域截断（Neighborhood Clamping）通过约束历史值在当前帧局部统计范围内，消除残留的时域伪影：

```glsl
// 收集当前帧3x3邻域的AO min/max
float ao_min = 1.0, ao_max = 0.0;
for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
        ivec2 neighbor = clamp(pixel + ivec2(dx, dy), ivec2(0), size - 1);
        float val = texelFetch(ao_input_tex, neighbor, 0).a;
        ao_min = min(ao_min, val);
        ao_max = max(ao_max, val);
    }
}
// 截断历史值到邻域范围
float history_ao = texture(ao_history_tex, prev_uv).a;
return clamp(history_ao, ao_min, ao_max);
```

注意：**弯曲法线（Bent Normal）不执行邻域截断**，因为对方向向量执行min/max操作缺乏物理意义。AO通道（A）与Bent Normal通道（RGB）采用不同的历史处理策略。

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L120-L135)

## 时域混合与输出

### 混合策略

通过三层验证的历史数据与当前帧数据执行线性混合，混合因子`temporal_blend`来自AOConfig运行时配置：

```glsl
float blend = rejected ? 0.0 : pc.temporal_blend;
float result_ao = mix(current.a, history_ao, blend);
```

当历史被拒绝时，blend强制为0，输出纯当前帧数据（等同于关闭时域滤波）。首帧或缓冲区大小变化时，`ao_history_valid`标志为false，C++侧传递的blend值同样为0。

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L164-L168)

### 弯曲法线特殊处理

弯曲法线（RGB通道）存储在[0,1]编码空间中，混合后需要重新归一化以保持单位长度：

```glsl
vec3 history_bent = rejected ? current.rgb : texture(ao_history_tex, prev_uv).rgb;
vec3 result_bent = mix(current.rgb, history_bent, blend);

// Decode → normalize → re-encode
vec3 bn = result_bent * 2.0 - 1.0;
bn = (dot(bn, bn) > EPSILON) ? normalize(bn) : vec3(0.0, 0.0, 1.0);
```

归一化步骤至关重要，因为编码值的线性平均会导致方向向量的长度衰减，长期积累会产生视觉偏差。

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L170-L180)

## 调度与性能

### Compute Shader配置

AO时域滤波作为纯计算任务执行，避免Graphics Pipeline的固定函数开销：

| 参数 | 值 | 说明 |
|------|-----|------|
| Workgroup Size | 8×8 | 64线程/Warp友好配置 |
| 共享内存 | 无 | 每线程独立采样，无交叉依赖 |
| 输出格式 | RGBA8 | Bent Normal(RGB) + AO(A) |

Dispatch尺寸按输出图像向上对齐：`((width + 7) / 8, (height + 7) / 8, 1)`。

Sources: [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L30-L32)

### 资源访问模式

Render Graph精确声明资源读写语义，确保屏障正确插入：

```cpp
const std::array resources = {
    RGResourceUsage{ctx.depth,        Read, Compute},
    RGResourceUsage{ctx.ao_blurred,   Read, Compute},
    RGResourceUsage{ctx.ao_history,   Read, Compute},
    RGResourceUsage{ctx.depth_prev,   Read, Compute},
    RGResourceUsage{ctx.ao_filtered,  Write, Compute},
};
```

所有输入资源标记为`Read`阶段`Compute`，输出标记为`Write`阶段`Compute`，Render Graph据此生成适当的Vulkan Pipeline Barrier。

Sources: [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L144-L170)

## 集成与扩展

### 与其他Pass的协作

时域滤波Pass在AO管线中的位置决定了其数据依赖关系：

```
[GTAOPass]         → ao_noisy (原始AO计算)
    ↓
[AOSpatialPass]    → ao_blurred (5×5双边滤波)
    ↓
[AOTemporalPass]     → ao_filtered (时域滤波，本文主题)
    ↓
[History Copy]     → ao_history (下一帧历史输入)
```

空域降噪先行处理，消除高频噪声以避免时域混叠；时域滤波后处理，利用帧间相关性进一步平滑低频变化。

Sources: [ao_temporal_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_temporal_pass.h#L11-L13)

### 向其他效果的扩展

时域滤波框架不仅限于AO，同样适用于：
- **接触阴影**（[Contact Shadows](https://github.com/1PercentSync/himalaya/blob/main/21-jie-hong-yin-ying-pass)）：历史阴影掩码的时域稳定
- **路径追踪**（[Reference View](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu)）：累积缓冲的时间域收敛
- **TAA（时域抗锯齿）**：运动向量驱动的多帧颜色混合

通用模式为：重投影坐标计算 → 有效性验证 → 自适应混合。具体效果的差异主要体现在邻域统计的维度（标量AO vs 向量颜色）和拒绝阈值的敏感度调整。

Sources: [ao_temporal_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_temporal_pass.h#L1-L15)

## 调试与调优

### 运行时参数

通过`AOConfig`暴露的`temporal_blend`参数控制混合强度，典型值：
- **0.9-0.95**：静态场景，追求最大稳定性
- **0.7-0.8**：动态场景，平衡响应速度与噪声
- **0.0**：完全禁用（调试或首帧场景）

当`ao_history_valid`为false时，系统自动强制blend为0，确保无有效历史时不进行错误混合。

Sources: [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L206-L210)

### 验证可视化

调优时可临时修改着色器输出中间结果进行验证：
- 输出`vec3(rejected ? 1.0 : 0.0)` — 观察拒绝区域分布
- 输出`abs(current.a - history_ao)` — 检查帧间差异热点
- 输出`vec3(depth_diff > 0.05 ? 1.0 : 0.0)` — 可视化深度拒绝触发点

这些可视化手段帮助平衡拒绝敏感度，避免过于保守导致时域优势丧失，或过于激进产生鬼影伪影。
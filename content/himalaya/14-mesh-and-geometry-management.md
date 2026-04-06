This page covers the unified vertex format, mesh data structures, and geometry processing pipeline that form the foundation of scene rendering in Himalaya. The system bridges CPU-side glTF loading with GPU-accelerated rasterization and ray tracing through a carefully designed data flow that prioritizes cache efficiency and minimal draw call overhead.

## Unified Vertex Format

Himalaya uses a single fixed-layout vertex format for all meshes, eliminating the need for shader permutations or vertex format switching at runtime. The `Vertex` structure packs all commonly used attributes into 56 bytes, with sensible defaults applied during loading when source data is missing.

```cpp
struct Vertex {
    glm::vec3 position;     // World-space position
    glm::vec3 normal;       // Surface normal (normalized)
    glm::vec2 uv0;          // Primary texture coordinates
    glm::vec4 tangent;      // Tangent with handedness in w (MikkTSpace convention)
    glm::vec2 uv1;          // Secondary texture coordinates (glTF TEXCOORD_1)
};
```

The vertex layout is exposed to the Vulkan pipeline through `binding_description()` and `attribute_descriptions()` methods, which configure a single vertex buffer binding with five attribute locations. This design enables all mesh types—static, skinned, opaque, and masked—to share the same pipeline vertex input state, reducing pipeline state changes during rendering.

Sources: [mesh.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/mesh.h#L19-L37), [mesh.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/mesh.cpp#L77-L104)

## Tangent Space Generation

When glTF meshes lack precomputed tangents but provide normals and UV coordinates, the framework generates tangent vectors using the **MikkTSpace** algorithm. This industry-standard approach ensures consistent tangent space across all assets, which is critical for correct normal mapping. The implementation uses MikkTSpace's callback-based interface to operate directly on vertex spans, avoiding intermediate data copies.

The tangent's w-component stores the handedness (±1.0) required to reconstruct the bitangent as `cross(normal, tangent.xyz) * tangent.w`. This convention matches the reference implementation used by major DCC tools and game engines.

Sources: [mesh.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/mesh.cpp#L12-L71)

## GPU Mesh Representation

The `Mesh` structure represents GPU-resident geometry, holding buffer handles and metadata needed for draw calls. Each mesh corresponds to one glTF primitive, enabling material-per-primitive granularity while allowing higher-level grouping for instancing and acceleration structure construction.

```cpp
struct Mesh {
    rhi::BufferHandle vertex_buffer;
    rhi::BufferHandle index_buffer;
    uint32_t vertex_count = 0;
    uint32_t index_count = 0;
    uint32_t group_id = 0;      // glTF source mesh index for BLAS grouping
    uint32_t material_id = 0;   // Index into material_instances array
};
```

The `group_id` field is particularly significant for ray tracing: all primitives sharing the same `group_id` are merged into a single multi-geometry BLAS (Bottom Level Acceleration Structure), reducing TLAS instance count and improving traversal performance. The `material_id` enables alpha mode classification during acceleration structure builds and links geometry to its shading parameters.

Sources: [mesh.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/mesh.h#L46-L76)

## Scene Instance Management

Mesh instances connect geometry to the scene graph through the `MeshInstance` structure. Each instance references a mesh by index, carries material and transform information, and maintains a world-space AABB for culling.

```cpp
struct MeshInstance {
    uint32_t mesh_id;
    uint32_t material_id;
    glm::mat4 transform;
    glm::mat4 prev_transform;   // For motion vectors (M2+)
    AABB world_bounds;
};
```

The `SceneLoader` generates one `MeshInstance` per glTF node-primitive combination during scene graph traversal. This expansion allows individual primitives to have distinct world transforms while sharing the underlying GPU buffers. The loader also computes world-space AABBs by transforming the eight corners of each primitive's local bounds, providing accurate frustum culling data.

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L50-L65), [scene_loader.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/scene_loader.cpp#L600-L650)

## Frustum Culling

The culling system extracts a six-plane frustum from the view-projection matrix using the Gribb-Hartmann method, then tests each instance's world-space AABB against all planes. The implementation uses the **p-vertex approach**: for each plane, it selects the AABB corner most aligned with the plane normal (the "p-vertex"). If this corner lies outside the plane, the entire AABB is outside.

This conservative test has no false negatives—objects that pass may still be occluded by other geometry, but objects that fail are definitely invisible. The output is a simple index list of visible instances, which the renderer then sorts and groups for instanced draw calls.

Sources: [culling.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/culling.h#L1-L60), [culling.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/culling.cpp#L1-L81)

## Acceleration Structure Construction

For ray tracing paths, the `SceneASBuilder` constructs a two-level acceleration structure hierarchy from the loaded scene data. The process follows five distinct phases:

**Phase 1: Grouping by Source Mesh** — Meshes are grouped by `group_id`, with each group becoming a multi-geometry BLAS. This preserves glTF's mesh-primitive hierarchy while minimizing BLAS count.

**Phase 2: BLAS Batch Build** — All BLAS are built in a single `vkCmdBuildAccelerationStructuresKHR` call using one large scratch buffer. This enables parallel GPU construction and reduces command buffer overhead.

**Phase 3: Geometry Info SSBO** — A GPU-side buffer is populated with `GPUGeometryInfo` entries containing vertex/index buffer device addresses and material buffer offsets. Ray tracing shaders access this via `gl_InstanceCustomIndexEXT + gl_GeometryIndexEXT`.

**Phase 4: Instance Deduplication** — The builder steps through mesh instances by group strides, creating one TLAS instance per unique `(group_id, transform)` pair. This automatically instances identical geometry across the scene.

**Phase 5: TLAS Build** — The final top-level acceleration structure is built from the instance array.

Sources: [scene_as_builder.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_as_builder.h#L1-L101), [scene_as_builder.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/scene_as_builder.cpp#L1-L249)

## Geometry Lookup in Ray Tracing Shaders

The ray tracing pipeline uses a bindless geometry info buffer to fetch vertex data during intersection shading. Each `VkAccelerationStructureInstanceKHR` carries a `instanceCustomIndex` set to the group's base offset in the geometry info array. The shader then adds `gl_GeometryIndexEXT` (the geometry index within the BLAS) to access the correct entry.

```cpp
struct GPUGeometryInfo {
    uint64_t vertex_buffer_address;
    uint64_t index_buffer_address;
    uint32_t material_buffer_offset;
    uint32_t _padding;
};
```

This indirection enables efficient material and geometry access without requiring per-instance descriptor sets or push constants, keeping the ray tracing shader interface minimal and cache-friendly.

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L298-L308), [acceleration_structure.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/acceleration_structure.h#L1-L161)

## Loading Pipeline Integration

The `SceneLoader` orchestrates the complete geometry loading sequence: parsing glTF via fastgltf, creating vertex/index buffers with appropriate usage flags (including `ShaderDeviceAddress` and `AccelStructBuildInput` when RT is enabled), generating missing tangents, computing local AABBs, and finally traversing the scene graph to produce world-space instances.

When RT is supported, buffer creation automatically includes the necessary usage flags for acceleration structure builds. The loader also handles degenerate primitives gracefully—those with zero vertices or fewer than three indices are skipped during BLAS construction but still consume instance slots to maintain index alignment.

Sources: [scene_loader.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/scene_loader.h#L1-L171), [scene_loader.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/scene_loader.cpp#L200-L400)

## Related Documentation

- For the RHI-level acceleration structure implementation, see [Ray Tracing Infrastructure (AS, RT Pipeline)](https://github.com/1PercentSync/himalaya/blob/main/11-ray-tracing-infrastructure-as-rt-pipeline)
- For material data management and GPU layout, see [Material System and PBR](https://github.com/1PercentSync/himalaya/blob/main/13-material-system-and-pbr)
- For scene loading and glTF parsing details, see [Scene Loading (glTF)](https://github.com/1PercentSync/himalaya/blob/main/25-scene-loading-gltf)
- For culling integration with the render graph, see [Scene Data and Culling](https://github.com/1PercentSync/himalaya/blob/main/16-scene-data-and-culling)
# albersUsa 组合投影：屏幕分区、拾取反算与"画回原位置"的条件

本文分析 `src/projection/albersUsa.js` 里美国分区图（本土 + 阿拉斯加 + 夏威夷两个 inset）的实际实现，
给出 **平移/缩放之后的屏幕分区公式**、**给定像素该用哪套反算**、**什么时候把反算出的经纬度再画回地图会得到原像素**，
以及 **"能算出坐标" 与 "该像素确实绘有地物" 是两件不同的事**所各自需要满足的条件。

文中所有数值都是在默认参数（`scale = 1070`、`translate = [480, 250]`）下、用本仓库源码实测得到的。

---

## 0. 结论速览

1. **反算是按像素矩形硬分派的，三选一**：`albersUsa.invert` 只用归一化像素坐标
   `u = (x − tx)/s`、`v = (y − ty)/s` 判断落在哪个矩形，然后调用 `lower48` / `alaska` / `hawaii`
   中某一个的 `invert`。它**既不检查 clip，也不检查该像素上画了什么**。
2. 三个矩形（`albersUsa.js:41-49`，与 `albersUsa.js:71-84` 的 `clipExtent` 同源）：

   | 区域 | 归一化条件（`u,v`） | 使用的反算 |
   |---|---|---|
   | 阿拉斯加 | `−0.425 ≤ u < −0.214` 且 `0.120 ≤ v < 0.234` | `alaska.invert` |
   | 夏威夷 | `−0.214 ≤ u < −0.115` 且 `0.166 ≤ v < 0.234` | `hawaii.invert` |
   | 其余（含本土图框内、图框外） | 其他一切 | `lower48.invert` |

   注意区间是**半开**的、且只在 `max` 侧开放：阿拉斯加右边界 `u = −0.214` 归夏威夷（当 `v ≥ 0.166`），
   夏威夷右边界 `u = −0.115` 归本土，等等。
3. 默认参数下换算成像素：

   | 区域 | x 范围 | y 范围 |
   |---|---|---|
   | 本土图框（L48 clip） | −6.85 … 966.85 | −4.66 … 504.66 |
   | 阿拉斯加框 | 25.25 … 251.02 | 378.40 … 500.38 |
   | 夏威夷框 | 251.02 … 356.95 | 427.62 … 500.38 |

   图框 `[−6.85, 966.85] × [−4.66, 504.66]` 恰好（略微）包住 960×500 画布：所以**默认画布上的每个整数像素都在图框内**。
4. `invert` 在**全平面**都有定义：它总是返回一个 `[lon, lat]` 数组（`NaN` 输入给 `[NaN, NaN]`），
   图框外也照算（外推），不会返回 `null`。`forward`（`albersUsa([lon, lat])`）才可能返回 `null`：
   三个子投影的 `clipExtent` 都不接受该点时为 `null`。
5. **把反算出的经纬度画回去得到原像素**的条件是：像素严格位于所属分支的 clip 矩形内部（留出约 1e-6 px 余量），
   且更早被尝试的分支（顺序 L48 → Alaska → Hawaii）都不接受该点。默认 960×500 画布上
   **480000 个整数像素全部满足**，残差 ≤ 2e-12 px；失败只发生在
   **图框边线和 inset 框线**（浮点残差/epsilon 把回投点挤出 clip）以及图框外。
6. **"有坐标" ≠ "有地物"**：阿拉斯加/夏威夷框远大于实际陆地（美国州数据下分别只有 19.0% / 6.2% 的像素着色），
   空白水域照样能反算出坐标；反过来，绘制世界陆地时 inset 框里的墨迹大部分来自本土流（墨西哥/下加利福尼亚），
   点击那里得到的却是阿拉斯加/夏威夷坐标。判断"确有地物"必须另外用 `geoContains` 或渲染 alpha 判定 **且** 确认墨迹来自同一分支。

---

## 1. 代码路径

### 1.1 三个子投影

`src/projection/albersUsa.js:28-31`：

```js
lower48 = albers(),                                  // parallels [29.5,45.5], rotate [96,0], center [-0.6,38.7], scale k, translate [tx,ty]
alaska  = conicEqualArea().rotate([154, 0]).center([-2, 58.5]).parallels([55, 65]),   // EPSG:3338
hawaii  = conicEqualArea().rotate([157, 0]).center([-3, 19.9]).parallels([8, 18]),    // ESRI:102007
```

`albersUsa.scale(s)`（`albersUsa.js:61-65`）设置：

- `lower48.scale(s)`、`alaska.scale(0.35 s)`、`hawaii.scale(s)`，
- 然后重新调用 `albersUsa.translate(lower48.translate())` 让框随缩放重建。

`albersUsa.translate([tx, ty])`（`albersUsa.js:67-87`）设置：

- `lower48`：`translate([tx,ty])`，`clipExtent = [[tx−0.455s, ty−0.238s], [tx+0.455s, ty+0.238s]]`；
- `alaska`：`translate([tx−0.307s, ty+0.201s])`，`clipExtent = [[tx−0.425s+ε, ty+0.120s+ε], [tx−0.214s−ε, ty+0.234s−ε]]`；
- `hawaii`：`translate([tx−0.205s, ty+0.212s])`，`clipExtent = [[tx−0.214s+ε, ty+0.166s+ε], [tx−0.115s−ε, ty+0.234s−ε]]`。

其中 `ε = 1e-6`（`src/math.js:1`），单位是**屏幕像素**。注意阿拉斯加/夏威夷的 `translate` 是
"该子投影的 `center` 落在哪个像素"，并不是框的中心。

### 1.2 正向（`albersUsa([lon,lat])`）

`albersUsa.js:33-39`：

```js
return point = null,
    (lower48Point.point(x, y), point)
    || (alaskaPoint.point(x, y), point)
    || (hawaiiPoint.point(x, y), point);
```

`lower48Point` 等是 `子投影.translate(...).clipExtent(...).stream(pointStream)`。
`clipRectangle` 的 `point`（`src/clip/rectangle.js:14-16`）只做 `x0 <= x && x <= x1 && y0 <= y && y <= y1` 的判定。
所以正向是 **L48 优先、失败再试 Alaska、再试 Hawaii**；三个都不接受就返回 `null`。
`rotate`、`project`、`resample`、`clipExtent` 依次作用在流上（`src/projection/index.js:89`、`157-163`）。

### 1.3 反向（`albersUsa.invert`）

`albersUsa.js:41-49`：

```js
albersUsa.invert = function(coordinates) {
  var k = lower48.scale(),
      t = lower48.translate(),
      x = (coordinates[0] - t[0]) / k,
      y = (coordinates[1] - t[1]) / k;
  return (y >= 0.120 && y < 0.234 && x >= -0.425 && x < -0.214 ? alaska
      : y >= 0.166 && y < 0.234 && x >= -0.214 && x < -0.115 ? hawaii
      : lower48).invert(coordinates);
};
```

要点：

- `k`、`t` 每次调用时从 `lower48` 现取，所以 `albersUsa.invert` **自动跟踪** `scale()`/`translate()` 的修改。
- 这是纯像素空间的 if/else，**不涉及 clipExtent、不涉及 antimeridian 预处理、不涉及任何绘制状态**。
- 三个 `invert` 都是解析反算（`projectRotateTransform.invert` → `compose` →
  `scaleTranslate` 的线性反解 + `conicEqualAreaRaw.invert` 的闭式解，见 `src/projection/index.js:84-87`、
  `src/compose.js`、`src/projection/conicEqualArea.js:18-24`），没有迭代、没有"该点是否可见"的判断。
- `lower48.invert` 之类的返回值是**未经旋转的球面经纬度**（`rotate.invert` 已经还原），度为单位。
- 由于 `project.invert` 对任意有限输入都返回数组，**`albersUsa.invert` 永不返回 `null`**；
  极端输入给 `[lon, ±90]`（例如 `invert([1e12, 1e12]) → [−21.353, −90]`），`NaN` 输入给 `[NaN, NaN]`。

### 1.4 绘制路径

`albersUsa.js:51-53`：

```js
return cache = multiplex([lower48.stream(...), alaska.stream(...), hawaii.stream(...)]);
```

`multiplex`（`albersUsa.js:8-18`）把每个输入的点/线/多边形**分别**送进三个流，三个流各自做
antimeridian 预处理、投影、resample、`clipExtent`。因此：

- 一个几何体只会被"球面上属于它"的那个流保留下来（代码注释所依赖的前提，
  `albersUsa.js:6-7`）；
- 但 `clipExtent` 是**投影后**的像素矩形，不同球面区域可以投影进同一个矩形，**没有"挖洞"**：
  本土流的 clip 是整个图框，它包含两个 inset 矩形；
- `sphere()` 被广播给三个流，所以 `path({type: "Sphere"})` 画出的是 **三个矩形**
  （图框 + 阿拉斯加框 + 夏威夷框），实测默认下为
  `M-6.85,-4.66L966.85,-4.66L966.85,504.66L-6.85,504.66Z` 加两个 inset 四边形。
  也就是说，框线本身也是"墨迹"。

---

## 2. 平移、缩放后的屏幕分区

### 2.1 公式

设当前 `s = albersUsa.scale()`、`[tx, ty] = albersUsa.translate()`，对屏幕像素 `(x, y)` 定义

```
u = (x − tx) / s
v = (y − ty) / s
```

则（与源码逐字对应）：

```
ALASKA  : −0.425 ≤ u < −0.214  ∧  0.120 ≤ v < 0.234
HAWAII  : −0.214 ≤ u < −0.115  ∧  0.166 ≤ v < 0.234
LOWER48 : 其余全部（包括 L48 图框内、两个框之间、图框外）
```

L48 的**绘制**范围（`clipExtent`，闭区间）：

```
−0.455 ≤ u ≤ 0.455  ∧  −0.238 ≤ v ≤ 0.238
```

ALASKA / HAWAII 的**绘制**范围比上面的分派范围在四条边上各内缩 `ε = 1e-6` 像素。

> 关键点：`u,v` 是**按当前 scale 归一化**的。`scale(s)` 不只是放大图形，它同时把三个框按 `s` 缩放、
> 并把 Alaska 自己的投影缩放设为 `0.35 s`、Hawaii 设为 `s`；`translate([tx,ty])` 只是整体平移。
> 所以任何时候都直接用当前的 `s, tx, ty` 代公式，不要记死像素值。

### 2.2 默认参数（`s = 1070`, `tx,ty = 480,250`）

| 区域 | x | y | 认知 |
|---|---|---|---|
| 图框 | −6.850 … 966.850 | −4.660 … 504.660 | 比 960×500 画布略大，整块画布都在框内 |
| ALASKA 框 | 25.250 … 251.020 | 378.400 … 500.380 | 分派 `[25.25, 251.02) × [378.4, 500.38)` |
| HAWAII 框 | 251.020 … 356.950 | 427.620 … 500.380 | 分派 `[251.02, 356.95) × [427.62, 500.38)` |

几何示意（`u` 向右、`v` 向下）：

```
 v
0.238 ┌────────────────────────────────────────────────────────┐  图框上边
      │                                                        │
0.234 │        ┌────────────────┬──────────────┐               │
      │        │                │              │               │
      │        │    ALASKA      │   HAWAII     │               │
0.166 │        │                ├──────────────┘               │
      │        │                │  ← 这块缺口 (u∈[-0.214,-0.115),
0.120 │        └────────────────┘     v∈[0.120,0.166)) 是 L48   │
      │                                                        │
-0.238└────────────────────────────────────────────────────────┘  图框下边
     -0.455   -0.425         -0.214       -0.115            0.455
```

值得记住的几个"缝"：

- **阿拉斯加框底边 `v = 0.120`**（默认 `y = 378.4`）在浮点里是 `0.11999999999999998`，
  于是 `v >= 0.120` 不成立 → 该线归 **L48**，而不是阿拉斯加。
- **夏威夷框右边界 `u = −0.115`**（默认 `x = 356.95`）因为条件是严格 `u < −0.115`，
  该线归 **L48**。
- **两框共用边 `u = −0.214`**（默认 `x = 251.02`）：当 `v ≥ 0.166` 时归 **HAWAII**，
  当 `0.120 ≤ v < 0.166` 时归 **L48**（阿拉斯加要求 `u < −0.214`，夏威夷要求 `v ≥ 0.166`）。
- **上边 `v = 0.234`**（默认 `y = 500.38`）在浮点里是 `0.23399999999999999 < 0.234`，
  因此该线仍归 Alaska/Hawaii 分派；但绘制 clip 的上边界是 `v ≤ 0.234 − ε`，所以回投为 `null`。
- 默认 960×500 画布只到 `y = 499`，所以 `y = 500.38` 这条上边在画布之外；其余框线（`x = 25.25 / 251.02 / 356.95`、
  `y = 378.4 / 427.62`）都在画布内。

### 2.3 换一组平移/缩放

例如 `geoAlbersUsa().scale(2000).translate([500, 300])`（`s=2000, tx=500, ty=300`）：

| 区域 | x | y |
|---|---|---|
| 图框 | −410 … 1410 | −176 … 776 |
| ALASKA | −350 … 72 | 540 … 768 |
| HAWAII | 72 … 270 | 632 … 768 |

公式不变，只是 `u,v` 的换算基数变了。实测该参数下把"框线本身"排除后，图框内部同样是 100% 回投。

---

## 3. 反算与"画回原位置"

### 3.1 给定像素用哪套反算

决策过程就是两条区间判断，建议直接照抄：

```js
const s = projection.scale(), [tx, ty] = projection.translate();
const u = (x - tx) / s, v = (y - ty) / s;
const inAlaska = u >= -0.425 && u < -0.214 && v >= 0.120 && v < 0.234;
const inHawaii = u >= -0.214 && u < -0.115 && v >= 0.166 && v < 0.234;
// 与 projection.invert 完全一致：inAlaska → alaska.invert；inHawaii → hawaii.invert；否则 lower48.invert
const lonlat = projection.invert([x, y]);
```

- 只需要 `scale()`/`translate()` 的当前值，**不需要**知道画布尺寸、缩略框画在哪、或当前数据是什么。
- 像素在**图框外**时仍然走 `lower48.invert`（"其余"分支），照样返回经纬度。
- 像素是 `NaN` 时返回 `[NaN, NaN]`；其余有限/无限输入都给数值。

### 3.2 画回原像素的条件

记 `B = 分派(p)`、`ℓ = B⁻¹(p)`、`P = albersUsa`。则

```
P(ℓ) === p
```

当且仅当：

1. **同一个分支接受它**：`B(ℓ)` 落在 `B` 的 `clipExtent` 内（`clipRectangle.visible` 为真）。
   由于 `ε = 1e-6` px 的内缩和浮点残差，实践上要求像素在框内至少 1e-6 px（稳妥起见 1e-6 px 以上）。
2. **没有更早的分支抢走它**：正向顺序是 L48 → Alaska → Hawaii，所以要求 `lower48(ℓ)` 不在图框内，
   并且（若 `B = Hawaii`）`alaska(ℓ)` 不在阿拉斯加框内。否则 `P(ℓ)` 会返回**另一个分支**的像。

在默认地图上这两条对**整块 960×500 画布的每个整数像素**都成立：实测 `p → invert → p` 精确相等
（容差 1e-6 px）的像素为 **480000 / 480000**，最大值残差 ≤ **2×10⁻¹² px**
（残差只来自浮点舍入，因为三个反算都是解析逆）。

### 3.3 会失败的地方（都是测度零或"图框外"）

**A. inset 框线本身**（分派 ∈ {AK, HI}，但绘制 clip 内缩了 `ε`，回投为 `null`）：

| 像素 | 分派 | 反算结果 | 画回 |
|---|---|---|---|
| `(25.25, 440)` 阿拉斯加左框线 | AK | `(167.1466, 56.2259)` | `null` |
| `(251.02, 490)` 两框共用线 | HI | `(−160.5361, 19.1868)` | `null` |
| `(300, 427.62)` 夏威夷下框线 | HI | `(−157.7755, 22.5694)` | `null` |
| `(100, 500.38)` 阿拉斯加上框线 | AK | `(−168.5845, 52.1303)` | `null` |

把坐标往框内挪 2×10⁻⁶ px 就恢复：`(25.250002, 440) → (167.1466, 56.2259) → (25.250002, 440)`。
也就是说，**这些失败带只有 1e-6 px 宽**，正常鼠标事件（浮点坐标）几乎不会落在上面，
但如果你自己构造"正好落在框线上"的像素（例如用几何边界做命中测试）就会踩到。

**B. 图框边线**（L48 clip 是闭区间，但反算残差可把回投点推到框外）：

| 像素 | 反算结果 | 画回 |
|---|---|---|
| `(−6.85, −4.66)` 左下角 | `(−135.678, 46.677)` | `null`（回投 dx = −1.4×10⁻¹³，落到框外） |
| `(−6.85, 250)` 左边线 | `(−128.944, 34.099)` | 视浮点而定，实测为 `null` |
| `(−6.849, 250)` 左边线内 1e-3 px | 同上 | `(−6.849, 250)` ✔ |
| `(480, 504.66)` 上边线中点 | `(−96.506, 25.101)` | `(480, 504.66)` ✔（这条边浮点侥幸落在框内） |
| `(966.85, 504.66)` 右上角 | `(−68.823, 21.349)` | `null` |

由于默认画布（0…959 × 0…499）完全在框内、且框线坐标都不是整数，**整数像素不会踩到这类失败**。
只有画布尺寸超出图框时（`width ≥ 968` 使 `x ≥ 967`，或 `height ≥ 506` 使 `y ≥ 505`；默认参数下即
`width > 967.85` / `height > 505.66`），画布边缘像素才会落到 L48 clip 之外。

**C. 图框外**：`invert` 仍然返回数值（外推），但回投：

- 实测在 `[−100, 1100] × [−100, 600]` 中排除图框内部的格点（步长 2）共 86766 个，
  **86134 个（99.3%）回投为 `null`**；
- **632 个（0.7%）"跳"到别处**：例如 `(13, −100)` → `(−137.407, 51.837)` → 正向得到 `(224.98, 500.34)`，
  正好落进阿拉斯加框。这是 `lower48.invert` 在球面上继续解析外推（经度绕回）造成的；
- 图框外的像素**没有观察到精确回投**。

**D. 极端输入**：`invert([1e12, 1e12]) → (−21.353, −90)`，`invert([NaN, NaN]) → (NaN, NaN)`；
这类值再画回通常是 `null` 或离谱位置。不要把"invert 有返回值"当成"拾取有效"。

### 3.4 一句话规则

> **在图框内部、且不在框线上（离框线 > 1e-6 px）的像素 → 反算再画回必然回到原像素；**
> **在 inset 框线上 → 可能得到 `null`；在图框外 → 通常 `null`，偶尔跳到别的框。**

---

## 4. "能算出坐标" vs "该处确实绘有地物"

这两件事的条件完全不同。

### 4.1 能算出坐标（`invert` 返回数值）的条件

1. 像素坐标是有限的（`NaN` 会原样传播成 `[NaN, NaN]`；`Infinity` 也会算出数）。
2. 命中 §2 的分派区间——**分派覆盖全平面**，"其余"兜底到 `lower48`，所以任何像素都有分支。
3. 该分支的 `invert` 是解析反算，**不检查 `clipExtent`**，因此在图框外也照算（外推）。
4. 没有任何标志位告诉你"这个坐标不在图上"；`null` 只可能来自**正向**，不会来自反向。

所以：**`invert` 能出数 ≠ 这个像素在地图上 ≠ 这个像素上有地物。**
例如默认参数下阿拉斯加框有 `27225` 个整数像素，全是可反算的。

### 4.2 该处确实绘有地物的条件

一个像素有墨迹，需要：

1. 某个几何体（Feature/Geometry）的坐标经过**它所属流**的 `rotate → project → resample → clipExtent`
   后仍有点落在该像素上（点要求 `visible`，线/多边形要求裁剪后仍非空）；
2. 该几何体的球面范围属于这个流（例如阿拉斯加的坐标只应被阿拉斯加流保留）；
3. 该像素被路径的填充/描边覆盖（含抗锯齿）；
4. **并且**：这段墨迹来自**与反算相同的分支**（见 4.3，这一条在通用数据下不成立）。

用州级数据（`test/data/us-10m.json`，仅美国各州）实测的覆盖率：

| 框 | 框内整数像素 | 有墨迹像素 | 占比 |
|---|---|---|---|
| 阿拉斯加框 | 27225 | 5160 | 19.0% |
| 夏威夷框 | 7488 | 462 | 6.2% |

也就是说，**81% / 94% 的框内像素"能算出坐标但什么都没有画"**（是白令海、北冰洋、太平洋的海面）。
反过来用世界陆地（`world-atlas/world/50m.json`）时框内墨迹比例高得多（阿拉斯加框 48.8%、夏威夷框 89.2%），
但原因见下。

### 4.3 反算分支 ≠ 画出墨迹的分支（重要陷阱）

如前所述，L48 的 `clipExtent` 是整个图框，**没有把两个 inset 矩形挖掉**。
因此本土流会把墨西哥/下加利福尼亚画进 inset 框的像素范围里，而 `invert` 却把该像素分派给阿拉斯加/夏威夷。

用世界陆地实测（默认参数）：

| 框 | 合成图墨迹 | 其中仅由 L48 画的 | 其中仅由 inset 流画的 | 两者都画 |
|---|---|---|---|---|
| 阿拉斯加框 | 13291 px | **896 px** | 9353 px | 3042 px |
| 夏威夷框 | 6682 px | **（全部 6682 都含 L48）** | 0 px | 458 px |

具体例子：

- 像素 `(126, 387)`：分派 → 阿拉斯加，反算 `(−168.288, 69.941)`，画回 `(126, 387)`；
  但该像素上的墨迹来自 L48 流（本土投影把这个像素解释为 `(−118.42, 29.13)`，即下加利福尼亚）。
  如果只画美国州数据，这里是空白；如果画世界陆地，这里能看到墨西哥——但点击得到的是阿拉斯加坐标。
- 像素 `(300, 470)`：分派 → 夏威夷，反算 `(−157.768, 20.283)`（海面），画回 `(300, 470)`；
  但世界陆地渲染在该像素有墨迹（L48 把它解释为 `(−107.21, 26.37)`，墨西哥索诺拉）。
- 夏威夷框内夏威夷流自己只画了 458 个像素（6.8% 的框内墨迹），其余墨迹都是 L48 的墨西哥。

只画美国各州数据时这个问题不存在：实测把全部 7663 个州级顶点分别投到两个框上，
在本土流下 **0 个**落进任何 inset 框，而在合成投影下有 **1897 个**落进阿拉斯加框、**86 个**落进夏威夷框，
球面裁剪区域互斥的假设成立。

### 4.4 判断"确有地物"的建议

```js
const lonlat = projection.invert([x, y]);
const back = projection(lonlat);
const hasPixel = back && Math.abs(back[0] - x) < 1e-9 && Math.abs(back[1] - y) < 1e-9; // 拾取是否自洽
const onFeature = hasPixel && feature // 你实际渲染的数据
  && geoContains(feature, lonlat);    // 球面上是否落在该要素内
```

- `geoContains` 在反子午线附近（阿留申群岛跨 180°）会有分歧：实测
  `(32, 470)` 的坐标 `(172.75, 52.82)` 在渲染上有墨迹但 `geoContains(Alaska)` 为 `false`，
  `(47, 483)` 的坐标 `(177.56, 52.07)` 反过来 `geoContains` 为 `true` 而该像素没墨迹。
  这类 ±180° 附近的点建议以"渲染 alpha 测试"为准，或先用 `geoContains` 前把经度规范化。
- 若用 Canvas，最稳的是对拾取层做一次 `getImageData(x, y, 1, 1)` 的 alpha 判定；
  但它只回答"有没有墨迹"，**不回答"墨迹属于哪个分支"**。要回答后者，可以维护一张
  "各流分别渲染"的掩码（本文的实测就是这样做的：把 `lower48/alaska/hawaii` 的 `clipExtent`
  分别手动设好、单独渲染一次，再逐像素比较）。
- 注意 `ε = 1e-6` 的 clip 内缩只是防止边界重复，视觉上无感；但**抗锯齿**会让 inset 框边界外约 1 px
  的像素带上浅色（实测单独渲染阿拉斯加流 + 世界陆地时，框外有 127 个像素 alpha ≈ 64，
  主要落在 `x = 25` 一列、`y ∈ [379, 419]`，也有零星分布到 `x = 250`），
  这是像素覆盖率造成的，不代表几何越界。

### 4.5 图框（`Sphere`）的框线

`albersUsa.stream` 把 `sphere()` 广播到三个流，所以如果你用 `path({type: "Sphere"})` 描边，
会得到 **三个矩形的轮廓**：图框 + 阿拉斯加框 + 夏威夷框。
这些轮廓线本身也是墨迹；恰好点在上面时，反算给的坐标和 §3.3 的边界行为一致（可能回投 `null`）。
如果你的编辑器把"图框线"也算作可拾取地物，需要显式排除。

---

## 5. 事件处理中的推荐写法

```js
function pick(projection, x, y) {
  const s = projection.scale();
  const [tx, ty] = projection.translate();
  const u = (x - tx) / s, v = (y - ty) / s;

  // 1) 与 projection.invert 相同的分派（纯像素空间，不需要数据或 clip 状态）
  const region = (u >= -0.425 && u < -0.214 && v >= 0.120 && v < 0.234) ? "alaska"
               : (u >= -0.214 && u < -0.115 && v >= 0.166 && v < 0.234) ? "hawaii"
               : "lower48";

  // 2) 反算（永远返回数组，可能是 NaN）
  const lonlat = projection.invert([x, y]);
  if (!lonlat || Number.isNaN(lonlat[0]) || Number.isNaN(lonlat[1])) return null;

  // 3) 自洽性检查：是否在对应分支的 clip 内部（留 1e-6 px 边界余量）
  const eps = 1e-6;
  const inFrame = u >= -0.455 && u <= 0.455 && v >= -0.238 && v <= 0.238;
  const inAK = u > -0.425 + eps / s && u < -0.214 - eps / s
            && v >  0.120 + eps / s && v <  0.234 - eps / s;
  const inHI = u > -0.214 + eps / s && u < -0.115 - eps / s
            && v >  0.166 + eps / s && v <  0.234 - eps / s;
  const inside = region === "alaska" ? inAK : region === "hawaii" ? inHI : inFrame;

  const back = projection(lonlat);
  const roundtrip = back && Math.abs(back[0] - x) < 1e-9 && Math.abs(back[1] - y) < 1e-9;

  return {region, lonlat, inside, roundtrip};
}
```

- `region` 用来判断"该像素被解释成哪块地图"；
- `roundtrip` 用来剔除框线/框外的外推值；
- 若还要判断"确有地物"，接 `geoContains(renderedFeature, lonlat)` 或读渲染层的 alpha，
  **不要**把 `invert` 非 `null` 当作地物判据。

---

## 6. 复现方式

本文数字用本仓库源码直接计算。可在仓库根目录用 Node 复现（`vitest` 配置把 `d3-geo` 别名到 `src/index.js`）：

```bash
node --input-type=module <<'EOF'
import {geoAlbersUsa} from "./src/index.js";
const p = geoAlbersUsa();
const s = p.scale(), [tx, ty] = p.translate();
console.log(s, [tx, ty]);                    // 1070 [480, 250]
const rt = (x, y) => {
  const ll = p.invert([x, y]);
  const q = ll && p(ll);
  return { ll, back: q, same: !!(q && Math.abs(q[0]-x) < 1e-6 && Math.abs(q[1]-y) < 1e-6) };
};
console.log(rt(480, 250));      // L48 中心：(−96.6, 38.7) → 原像素
console.log(rt(171.2, 446.9));  // 阿拉斯加：Anchorage
console.log(rt(298.5, 451.0));  // 夏威夷：Honolulu
console.log(rt(25.25, 440));    // 阿拉斯加左框线：back === null
console.log(rt(-6.85, -4.66));  // 图框左下角：back === null
EOF
```

- 图框/inset 的绘制范围由 `albersUsa.translate` 里的 `clipExtent` 决定（`albersUsa.js:71-84`）。
- 分派区间由 `albersUsa.invert` 决定（`albersUsa.js:41-49`）。
- 各流分别绘制用于"墨迹来自哪个分支"的统计，可复制 `scale(s).translate(t)` 后的参数，
  对 `lower48/alaska/hawaii` 各自设置 `clipExtent` 再单独 `geoPath(子投影, ctx)`。
- 州数据：`test/data/us-10m.json`（TopoJSON，`states` 里 Alaska=id 2、Hawaii=id 15）；
  世界陆地：`node_modules/world-atlas/world/50m.json`。

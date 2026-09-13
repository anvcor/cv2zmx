# CV2ZMX

**CODE V 宏：把当前镜头直接写成 Zemax OpticStudio 的 `.zmx` 文件。**

传统流程是 `CODE V → .seq → Zemax 导入`，中间那一步用的是 Zemax 自己写的 `.seq`
解析器 —— 玻璃牌号、渐晕、变焦（多重结构）、非球面高次项都在那里丢过东西。

这套宏跳过中间商：在 CODE V 里读 LDM 数据库，**按 Zemax 的 `.zmx` 语法逐行写文件**。

已在 CODE V 2026 + OpticStudio 上实测通过，见文末「已实测」。

---

## 仓库内容

| 文件 | 运行时需要 | 说明 |
|---|:--:|---|
| `CV2ZMX.seq` | ✅ | 宏本体 |
| `CV2ZMX_GLASS.DAT` | ✅ | CODE V 玻璃名 → Zemax 玻璃名 / 目录，2445 条 |
| `make_glass_table.py` | — | 生成上表的脚本，两边玻璃库更新后重跑 |
| `CV2ZMX_GLASS_UNMATCHED.txt` | — | Zemax 目录里找不到对应牌号的 CODE V 玻璃清单（多为停产牌号） |

运行时只要前两个文件。

> `.gitignore` 是**允许列表**式的（先 `*` 全忽略，再逐个 `!` 放行）。
> 这个目录如果同时被当作 CODE V 的工作目录用，里面的 `.len` / `.zmx` / `.rec`
> 镜头数据不会被误提交。往目录里丢新文件前记得确认它是不是该进仓库。

---

## 安装

1. 把仓库 clone 或下载到任意位置，比如 `E:\tools\cv2zmx\`。

2. **打开 `CV2ZMX.seq`，把 `^gtable` 改成你放 `CV2ZMX_GLASS.DAT` 的路径**
   （在文件顶部 Settings 区，是唯一必须改的一行）：

   ```
   ^gtable    == "E:\tools\cv2zmx\CV2ZMX_GLASS.DAT"
   ```

   路径写绝对的最省事。如果那个 `.DAT` 就在 CODE V 的当前工作目录下，
   写成 `"CV2ZMX_GLASS.DAT"` 也行。

3. （可选）把 `CV2ZMX.seq` 复制进 `CODEV20xx\macro\`，之后就能直接 `in CV2ZMX`。
   `.DAT` 不用跟着走，`^gtable` 指哪算哪。

## 用法

CODE V 命令行：

```
in E:\tools\cv2zmx\CV2ZMX A2628
```

| 参数 | 含义 |
|---|---|
| `#1` | 输出文件名，缺 `.zmx` 自动补。不给就用当前镜头文件名 `(FIL)`，再不行用镜头标题 |
| `#2` | `Y` 回显每一条宏命令，调试用 |

**不带路径时写进的是 CODE V 的当前工作目录**，不是宏所在目录。跑完屏幕上会打印
`in directory`。要指定位置就把完整路径给第一个参数：

```
in E:\tools\cv2zmx\CV2ZMX E:\work\A2628.zmx
```

跑完打印面数 / 视场数 / 波长数 / 变焦位置数 / 玻璃数 / 用到的 Zemax 玻璃目录，
以及所有**没能带过去的东西**的警告。同样的警告会写进 `.zmx` 的 `NOTE` 行，
Zemax 里 File → Project Notes 能看到，不会无声丢失。

## 顶部设置区

`CV2ZMX.seq` 里 Settings 一段是唯一需要改的地方：

| 变量 | 默认 | 含义 |
|---|---|---|
| `^gtable` | 绝对路径 | 玻璃映射表位置。**装好后必须改** |
| `^fe` | `'2e.20e'` | 所有实数的输出格式。实测这一档给出小数点后 16 位 = 17 位有效数字，双精度跑满。**改的话下面 `BUF FMT` 那一处字面量要一起改** |
| `^opt_asp` | 0 | 0 = H(r¹⁸)/J(r²⁰) 为零时用 `EVENASPH`，非零时自动换 `XASPHERE`；1 = 一律 `XASPHERE` |
| `^opt_sd` | 0 | 0 = 只在 CODE V 有显式 `CIR` 的面上锁定半口径，其余交给 Zemax 自己算；1 = 全部按 `(SD Sk)` 锁死 |
| `^opt_model` | 0 | 表里查不到的玻璃：0 = 照写 CODE V 名字（Zemax 标成未知，你自己定）；1 = 写成 Zemax model glass（nd/Vd） |
| `^opt_ape` | 0 | 0 = 沿用 CODE V 的光阑定义方式；1 = 一律导出入瞳直径 `ENPD` |
| `^opt_mc` | 1 | 变焦位置 → Zemax 多重结构 |
| `^opt_note` | 1 | 警告同时写进 `.zmx` 的 NOTE |

---

## 关键换算（为什么比走 .seq 准）

### 渐晕

CODE V 说的是「上下各切掉多少」，Zemax 说的是「剩下的瞳在哪、多宽」：

```
VUY = VCY − VDY          →   VCY = (VUY + VLY) / 2
VLY = VCY + VDY              VDY = (VLY − VUY) / 2
```

X 方向同理。这组关系跟 Synopsys 官方 `ZEMAXOS_TO_CV.SEQ`（反方向）用的是同一组公式。

### 非球面

CODE V 的 `ASP` 有 A…J 共 9 个系数，r⁴ 到 r²⁰。
Zemax 的 Even Asphere 只到 **r¹⁶**（PARM 1…8 = r², r⁴ … r¹⁶），装不下 H(r¹⁸) 和 J(r²⁰)。
所以：

- H = J = 0 → `EVENASPH`，PARM1 = 0，PARM2…8 = A…G
- H 或 J 非零 → `XASPHERE`（Extended Asphere），
  `XDAT 1` = 项数 10，`XDAT 2` = 归一化半径 1.0，`XDAT 3…12` = r², r⁴ … r²⁰ 的系数

归一化半径取 1.0，系数就跟 CODE V 一一对应，不用再换算。

### 玻璃

CODE V 的牌号不能带连字符，所以 Zemax 的 `D-QK3L` 在 CODE V 里叫 `DQK3L`，
`M-TAFD315` 叫 `MTAFD315`。`make_glass_table.py` 把两边的目录都读一遍，
按「去掉 `-_.` 和空格后转大写」的规范名做匹配，生成映射表。宏按
`(GLA Sk)_(GLA Sk CAT)` 去查，查到就写 Zemax 名字，并把提供它的目录收进 `GCAT` 行。
查不到的逐条警告。

命中率（生成时的目录版本）：

| CODE V 目录 | 命中 | Zemax 目录 |
|---|---|---|
| CDGM | 343 / 389 | CDGM2025011 |
| HOYA | 435 / 456 | HOYA20260707 |
| OHARA | 428 / 500 | OHARA_240131 |
| HIKARI | 313 / 318 | NIKON-HIKARI20220701 |
| SCHOTT | 355 / 504 | SCHOTT |
| SUMITA | 222 / 320 | Sumita |
| NHG | 195 / 215 | NHG |

没命中的基本是停产牌号，清单见 `CV2ZMX_GLASS_UNMATCHED.txt`。

**没有这张表会怎样**：不报错，照常写文件，但拼法不同的牌号会原样写出去，
而且 `GCAT` 退回默认的 `SCHOTT`，等于两个目录都没挂上，Zemax 打开会把玻璃
全标成未知材料。

### 变焦 → 多重结构

逐项跟 Z1 比，有差异才写一组 MCE 行：

`LTTL`（变焦标题）`APER`（光阑值）`THIC` `CRVT` `CONN`（圆锥系数）
`PRAM` / `EDVA`（非球面系数，取决于面型）`SDIA` `WLWT`
`YFIE` `XFIE` `FLWT` `FVDY` `FVCY` `FVDX` `FVCX`

这些操作数名都在 `Documents\Zemax\ZOS-API\Libraries\ZOSAPII.tlb` 里核对过。

> `A2628.seq` 里 `ZOO FNO 2.9 2.94 3.0 3.1 3.45` 这种逐位置变化的 F 数，
> **走 .seq 导入是丢的** —— 参考转换结果里只有 `THIC` 和 `LTTL`，没有 `APER` 行。
> 这套宏会写出来。

### 其它

- 波长 nm → µm
- `DIM M/C/I` → `UNIT MM/CM/IN`
- `TYP FLD ANG/OBJ/IMG/RIH` → `FTYP 0/1/2/3`
- `(PRE)` mmHg ÷ 760 → `ENVD` 的 atm
- 物距 ≥ 1e9 → `DISZ INFINITY`（MCE 行里写 1e10，跟 Zemax 自己的写法一致）

---

## 带不过去的东西

每一条都会报警告，不会无声丢失：

- 偏心 / 倾斜 `XDE/YDE/ZDE/ADE/BDE/CDE`
- 环形面、柱面、Anamorphic 非球面、`SPS`/`UDS` 各类特殊面、梯度折射率、衍射面、Lens Module
- 非圆形 / 偏心的通光口径和遮拦
- solve、pickup、镀膜、公差、误差函数

两条需要人工确认的：

- **反射系统**（有 `RMD REFL` 的面）会单独提示检查 Zemax 里镜后厚度的正负号。
  这是 CODE V ↔ Zemax 之间最容易出错的一处，宏是原样搬运，没有替你翻符号。
- **有限共轭 + 用 F 数定光阑**时会提示：Zemax 的 "Image Space F/#" 是按无限共轭
  定义的，要严格一致就把 `^opt_ape` 设成 1，改用入瞳直径。

## 换到新机器后验一遍

1. CODE V 里打开一个已知镜头，跑宏。
2. Zemax 打开结果，对这几项：
   - Lens Data 的半径、厚度、玻璃、圆锥、非球面系数逐面对一遍
   - System Explorer → Aperture / Fields / Wavelengths
   - Multi-Configuration Editor 的行数和每列的值
   - 有效焦距、后焦、F 数（Prescription Data）
3. 两边各画一张同条件的 MTF 或点列图对比。

## 重新生成玻璃表

换机器、或者 CODE V / Zemax 更新了玻璃库之后：

```bash
python make_glass_table.py
```

脚本顶部三个常量要按本机改：

```python
CODEV_GLASS = r"...\CODEV20xx\glass"                  # CODE V 的 *.xml 玻璃目录
ZEMAX_GLASS = r"...\Documents\Zemax\Glasscat"         # Zemax 的 *.AGF 玻璃目录
OUT         = r"...\CV2ZMX_GLASS.DAT"
```

`CAT_MAP` 决定每个 CODE V 目录优先去哪个 Zemax 目录里找。可以列多个，按顺序回落 ——
这样停产牌号还能从旧目录里捞到，而且真正提供它的那个目录名会被写进 `GCAT`。
你机器上装的 Zemax 玻璃库版本号大概率跟这里不一样，跑之前先看一眼
`Glasscat` 目录里实际有哪些 `.AGF`。

## 排错

| 症状 | 处理 |
|---|---|
| 找不到输出文件 | 没给路径的话它在 CODE V 的当前工作目录里，屏幕报告的 `in directory` 那一行就是 |
| `Glass map not found` | `^gtable` 的路径不对 |
| Zemax 说玻璃找不到 | 看屏幕上的 `No Zemax counterpart for glass ...` 警告。要么把该牌号加进 `CV2ZMX_GLASS.DAT`（一行五个字段，空格分隔，**不要加注释行**），要么把 `^opt_model` 设成 1 用 model glass 顶一下 |
| 提示格式串出错 | 把 `^fe` 调小（比如 `'2e.15e'`），同时改下面 `BUF FMT` 那一处 |

---

## 已实测

2026-09-13，CODE V 2026，A2628（17 面 / 10 视场 / 5 波长 / 5 个变焦位置 / 8 种玻璃）。
输出 507 行、纯 ASCII、CRLF。逐项核对：

- 半径、厚度、圆锥、非球面系数与 `.seq` 完全一致，E 格式给到 17 位有效数字
- 8 种玻璃全部解析为 Zemax 牌号（`D-QK3L` `H-F4` `H-K9L` `TAF3D` `TAFD30L`
  `FF5` `TAC6L` `M-TAFD315`），`GCAT` 自动收敛成 `CDGM2025011 HOYA20260707`
- 渐晕换算与既有参考转换逐位一致
- 多重结构写出 `LTTL` / `APER` / `THIC` / `FLWT` / `FVDY` / `FVCY` / `FVDX` / `FVCX`，
  其中 `APER`（逐位置的 F 数）正是走 .seq 会丢的那一项
- `ENVD 22 1 0` —— CODE V 的参考温度默认就是 22 °C（LensSystemSetupRM p.864），
  不是笔误；Zemax 默认 20 °C，这里如实搬运

## 文件编码

`CV2ZMX.seq` 是 **GBK + CRLF**（注释里有中文）。用别的编辑器改完记得保持原编码，
或者把中文注释删掉改存 ASCII。`CV2ZMX_GLASS.DAT` 是纯 ASCII + CRLF，
每行五个空格分隔的字段，**不能有注释行或表头** —— 宏用无格式 `REA` 按空格切字段读它。

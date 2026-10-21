# CV2ZMX

**CODE V ⇄ Zemax OpticStudio 镜头文件双向转换，不经过两边自带的导入器。**

| 方向 | 工具 | 在哪跑 |
|---|---|---|
| CODE V → Zemax `.zmx` | 宏 `CV2ZMX.seq` | CODE V 里，读 LDM 数据库直接写 `.zmx` |
| Zemax `.zmx` → CODE V `.seq` | `zmx2seq`（网页 / 命令行） | 浏览器，或 Node.js |
| CODE V `.seq` → Zemax `.zmx` | `seq2zmx`（网页 / 命令行） | 浏览器，或 Node.js；不用装 CODE V |

**网页：<https://anvcor.github.io/cv2zmx/>** —— 拖进 `.zmx` 出 `.seq`，拖进 `.seq` 出 `.zmx`。

传统流程是 `CODE V → .seq → Zemax 导入`，中间那一步用的是 Zemax 自己写的 `.seq`
解析器 —— 玻璃牌号、渐晕、变焦（多重结构）、非球面高次项都在那里丢过东西。
反过来 CODE V 自带的 Zemax 导入/导出也一样丢（玻璃全变 nd=1.5、对焦结构写成同一个值、VDY 反号）。

这套工具跳过中间商：两个方向都**按对方文件的语法逐行写**，换算公式是同一套，
带不过去的东西逐条报警告，不会无声丢失。

宏已在 CODE V 2026 + OpticStudio 上实测通过，见「已实测」；`zmx2seq`、`seq2zmx` 的验证见各自一节。

---

## 仓库内容

| 文件 | 运行时需要 | 说明 |
|---|:--:|---|
| `CV2ZMX.seq` | ✅ 宏 | 宏本体（CODE V → Zemax） |
| `CV2ZMX_GLASS.DAT` | ✅ 两个方向都用 | CODE V 玻璃名 ⇄ Zemax 玻璃名 / 目录，2445 条 |
| `make_glass_table.py` | — | 生成上表的脚本，两边玻璃库更新后重跑 |
| `CV2ZMX_GLASS_UNMATCHED.txt` | — | Zemax 目录里找不到对应牌号的 CODE V 玻璃清单（多为停产牌号） |
| `web/zmx2seq.js` | ✅ zmx2seq | 转换器本体（Zemax → CODE V），一个没有依赖的 JS 模块，网页和命令行共用 |
| `web/seq2zmx.js` | ✅ seq2zmx | 转换器本体（CODE V `.seq` → Zemax），同上；借用 `zmx2seq.js` 的解码和近轴核对 |
| `web/index.html` `web/app.js` `web/zip.js` | — | 网页界面（拖入即转换，按扩展名判断方向） |
| `tools/zmx2seq.mjs` `tools/seq2zmx.mjs` | — | 命令行入口，可批量转换 |
| `tools/build-site.mjs` `tools/serve.mjs` | — | 组装网页 / 本地预览 |
| `test/` | — | 自动测试和测试样本（手写的 `.zmx` / `.seq`，不是设计数据） |
| `.github/workflows/pages.yml` | — | 每次推送跑测试；推到 `main` 时自动发布网页 |

宏运行时只要前两个文件。

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

## 网页（两个方向）

**<https://anvcor.github.io/cv2zmx/>**：把 `.zmx` 拖进去，自动下载 `.seq`；把 `.seq` 拖进去，自动下载 `.zmx`。
一次拖多个（两种可以混着）就打包成一个 `.zip`。转换全部在浏览器本地完成，文件不上传。
网页不设选项，一律用默认值；要改选项用命令行。

转不过去、需要核对的地方，网页上只显示条数（点开能看）。同样的内容写在输出文件里：
`.seq` 写在开头的 `!` 注释里（还有每个结构的近轴 EFL / BFL），`.zmx` 写在 `NOTE` 行里（还有每个结构的近轴 EFL），
拿到目标软件里一比就知道有没有转错。

网页的发布是自动的：`.github/workflows/pages.yml` 每次推送都跑测试，推到 `main` 时组装网页并发布。
**第一次要在仓库里开一下**：Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。

本地预览：`npm run serve`，打开 <http://localhost:8080/>。

## Zemax → CODE V：zmx2seq

### 命令行

```
node tools/zmx2seq.mjs A2628.zmx                        # 写出同目录的 A2628.seq
node tools/zmx2seq.mjs *.zmx -d out                     # 批量
node tools/zmx2seq.mjs lens.zmx -o E:\work\lens.seq --offset model
```

只要 Node.js 18 以上，没有其它依赖。`--help` 列出全部选项；不加选项时和网页的结果完全一样。
玻璃映射表默认用仓库里的 `CV2ZMX_GLASS.DAT`，`--glass` 可以换。

### 选项（命令行）

| 命令行 | 默认（网页就用这些） | 含义 |
|---|---|---|
| `--sd aperture\|fixed\|all` | `fixed` | `aperture` 只把口径（CLAP/FLAP）写成 CIR；`fixed` 再加上固定的半口径；`all` 所有半口径。CODE V 的 CIR 挡光，Zemax 的半口径不挡光，所以默认不碰自动半口径。宏导出的文件里 CIR 面正好是「固定半口径 + CLAP」，往返一致 |
| `--offset base\|model` | `base` | `base` 写基准牌号（保留色散曲线，丢掉 Nd/Vd 偏移）；`model` 写模型玻璃（保留 nd/vd，丢掉色散曲线）。CODE V 没有 Offset 玻璃解 |
| `--unknown model\|guess` | `model` | `model` 按 GLAS 行里的 nd/vd 写模型玻璃；`guess` 按名字拼成 `牌号_厂家`。nd/vd 缺失或是老版本写的占位值 1.5/40 时一律猜名字，并提示核对 |
| `--no-oal` | 写 | `TOLE` → `THI Sk OAL …` |
| `--no-vars` | 写 | MCE 里状态为变量的 THIC → `ZOO THC 0`，其余 `100` |
| `--keep-wave-order` | 从长到短 | CODE V 的习惯；`REF`、`WTW` 跟着重排 |
| `--keep-field-order` | 轴上在前 | 按视场从小到大；渐晕和 `ZOO … F<i>` 跟着重排 |
| `--encoding gbk\|utf-8` | `gbk` | 只有标题、标签里有中文时才有区别 |
| `--no-comments` | 写 | 来源、每个结构的近轴 EFL/BFL、全部警告（英文） |

### 换算（宏的逆运算）

- **渐晕**：`VUY = VCY − VDY`、`VLY = VCY + VDY`，X 方向同理。
- **孔径**：`ENPD` → `EPD`；`OBNA` → `NAO`；物方锥角 → `NAO = n·sinθ`；`FLOA` → 由光阑半口径近轴追迹换算。
  - `FNUM v 1`（近轴工作 F/#）→ `FNO`。有限共轭时 CODE V 用 sin、Zemax 用 tan，
    按 `FNO² = PWFN² + (β/2)²` 换算，两边入瞳相同（β 由近轴追迹得到）；无限远时数值不变。
  - `FNUM v 0`（像方 F/#，按无限远共轭定义）：全部结构都在无限远时直接写 `FNO`；
    有有限共轭结构时改写成 `EPD = EFL / F#`，并提示。
- **视场**：`FTYP 0/1/2/3` → `XAN YAN` / `XOB YOB` / `XIM YIM` / `XRI YRI`；半视场超过 90° 加 `WID Y`。
- **波长** µm → nm；`ENVD t p` → `TEM t`、`PRE p×760`。
- **面型**：`STANDARD` + `CONI` → `CON` + `K`；`EVENASPH` `PARM 2…8` → `ASP` `A…G`；
  `XASPHERE` `XDAT 4…12` → `ASP` `A…J`（归一化半径不是 1 时系数除以 Rn²ⁱ，精确）；
  r² 项、奇次项（`ODDASPH`、`XOSPHERE`）或 r²⁰ 以上 → `SPS ODD`（`C1 = K`，`C(n+1) = rⁿ`）；
  `BINARY_2` → `DIF DOE`，`HCO Cj = Aj·λ0/2π / Rn²ʲ`，`HWL` 取主波长；
  `COORDBRK` → 哑面 + `XDE YDE` / `ADE BDE CDE`；`MIRROR` → `REFL`。
- **玻璃**：牌号经 `CV2ZMX_GLASS.DAT` 反查成 `牌号_厂家`（`D-QK3L` → `DQK3L_CDGM`）；
  同一个牌号几家都有时按文件 `GCAT` 的顺序取（`H-K9L` 在 CDGM 和 NHG 都有）；
  `___BLANK` 模型玻璃 → `nnnnnn.vvvv`（1.5168 / 64.17 → `516800.6417`）。
- **口径**：`CLAP` → `CIR`（有内半径时加 `CIR OBS`），`FLAP` → `CIR`，`OBSC` → `CIR OBS`，口径偏心 → `ADX ADY`。
- **位置求解**：`TOLE from len`（写在面 k）→ `THI Sk OAL Sfrom..k+1 len`，该面不再写 `ZOO THI`（否则会把求解覆盖成定值）。
- **多重结构**：`MNUM n` → `ZOO n`；`LTTL` → `ZOO TIT` + `TIT Zk`；`THIC CRVT CONN SDIA GLSS` →
  `ZOO THI / CUY / K / CIR / GLA`；`PRAM`、`EDVA`（非球面系数、坐标断点）→ `ZOO A…J` / `ZOO XDE…`；
  `APER` → `ZOO FNO / EPD / NAO`（同上换算）；`YFIE XFIE FLWT FVDY FVCY FVDX FVCX` → `ZOO YAN… F<i>`、`ZOO WTF`、
  `ZOO VUY/VLY/VUX/VLX F<i>`；`WAVE WLWT PWAV TEMP PRES` → `ZOO WL / WTW / REF / TEM / PRE`。
  只写各结构确实不同的行。
- **数值**：Zemax 存曲率，`.seq` 写半径，取与 1/c 相对误差 2e-15 以内最短的十进制（`129.94` 而不是
  `129.93999999999988`）；其它数值一律是能精确还原双精度的最短写法。

### 带不过去的东西

每一条都会报警告，并写进 `.seq` 头部注释：

- 环形面、双锥面、柱面、Q 型非球面、Zernike 面、网格面等（只写基础曲率和圆锥系数），理想透镜面 `PARAXIAL`
- 面自带的 Tilt/Decenter（不是坐标断点的那种）
- 先倾斜后偏心（order = 1）且同时有偏心和倾斜、或 order = 1 多轴倾斜的坐标断点
- 非圆形口径（矩形、椭圆、用户定义）、渐晕角 `VAN`
- Offset 玻璃的偏移量（选 `base` 时）、模型玻璃的 ΔPgF
- 没有 CODE V 写法的多重结构操作数
- 公差、评价函数、镀膜；位置求解以外的厚度/曲率求解按当前值写出

会提示人工核对的：`SPS ODD` 面、衍射面（核对焦距）、坐标断点的倾斜方向、按名字猜出来的玻璃。

### 已验证

- `npm test`：zmx2seq 17 项自动测试（全部测试共 35 项）。样本有宏导出格式的 3 档变焦、OpticStudio 格式的对焦镜头（近轴工作 F/#、
  位置求解、Offset / 模型玻璃、UTF-16 编码）、特殊面型（SPS ODD、坐标断点、反射镜、DOE、口径），
  旧版没有 `TYPE` 行的文件，以及 GBK 中文标题。
- **往返**：变焦样本 → zmx2seq → `seq2zmx.py`（另一套独立写的 CODE V `.seq` → `.zmx` 脚本）→ 与原 `.zmx` 比对，
  面型、厚度、玻璃名、非球面系数、多重结构 `THIC / APER / FVDY / FVCY / FVCX`、视场、波长共 179 项全部一致。
- **第三方读取**：用开源光学库 rayoptics 分别读 15 个真实 `.zmx`（Edmund / Thorlabs 产品文件、专利镜头）和转出的 `.seq`，
  逐面矢高、厚度、偏心全部一致（最大矢高差 1.6e-13 mm）；两边能解析到同一牌号玻璃的 9 个文件，
  EFL、BFL、F 数、入瞳完全相同。其余差异都来自 rayoptics 自己的玻璃库（例如它的 SCHOTT 目录没有老牌号 BK7）。

**还没在 CODE V 里打开验证过。** 第一次用的时候请拿一个熟悉的镜头试一下：
`.seq` 头部注释里有每个结构的 EFL / BFL，和 CODE V 的一阶数据直接对；再看一眼多重结构和渐晕。

## CODE V → Zemax（不用 CODE V）：seq2zmx

手上只有 `.seq`、没有 CODE V 时用它；**装了 CODE V 的话优先用宏**：宏读的是 CODE V 算好的数据库
（求解、拾取都已经算成数值，私有玻璃、各种面型 CODE V 自己认得），seq2zmx 只能读文件里写了什么。

能读的 `.seq`：CODE V 保存出来的镜头文件（开头是 `RDM;LEN`），手写的，或者 zmx2seq 写出来的。
宏文件（比如 `CV2ZMX.seq` 本身）不是镜头，会直接提示。写出的 `.zmx` 和宏写的版式相同，
纯 ASCII；标题里有中文时是 UTF-16LE 带 BOM（OpticStudio 自己存盘也是这样）。

### 命令行

```
node tools/seq2zmx.mjs lens.seq                         # 写出同目录的 lens.zmx
node tools/seq2zmx.mjs *.seq -d out                     # 批量
node tools/seq2zmx.mjs lens.seq -o E:\work\lens.zmx --glass my_glass.dat
```

没有别的选项。每个文件会打印面数、结构数、每个结构的近轴 EFL / BFL 和全部警告。

### 换算（zmx2seq 的逆运算）

- **读法**：`;` 分隔多条命令，`&` 续行，`!` 注释；`S5`、`F2`、`W1`、`Z3` 等限定词都认。
  没有 `RDM` 时按 CODE V 的默认读**曲率**，`RDM` / `RDM Y` 读半径。
- **渐晕**：`VCY = (VUY + VLY)/2`、`VDY = (VLY − VUY)/2`，X 方向同理。
- **孔径**：`EPD` → `ENPD`；`NAO` → `OBNA`；`NA` → 工作 F/# = 1/(2NA)；
  `FNO` → `FNUM v 1`（近轴工作 F/#，和 CODE V 的 FNO 是同一个定义）。有限共轭时按
  `PWFN = √(FNO² − (β/2)²)` 换算，两边入瞳相同（β 由近轴追迹得到）。
- **视场**：`XAN YAN` / `XOB YOB` / `XIM YIM` / `XRI YRI` → `FTYP 0/1/2/3`。
- **波长** nm → µm，`WTW` → 权重，`REF` → `PWAV`（没写 `REF` 时取第 1 个波长）；`TEM` `PRE` → `ENVD`（没写时 22 °C、1 atm）。
- **面型**：`CON` + `K` → `STANDARD` + `CONI`；`ASP` `A…G` → `EVENASPH` `PARM 2…8`，用到 `H`、`J` 时 → `XASPHERE`；
  `SPS ODD` → `XASPHERE`（只有偶次项）或 `XOSPHERE`；`DIF DOE` → `BINARY_2`（`XDAT 2+j = 2π/λ0 · Cj`，λ0 取 `HWL`）；
  只有偏心/倾斜、没有曲率和材料变化的哑面 → `COORDBRK`；`REFL` → `MIRROR`。
- **玻璃**：`牌号_厂家` 经 `CV2ZMX_GLASS.DAT` 查成 Zemax 牌号和目录（`DQK3L_CDGM` → `D-QK3L`，目录自动加进 `GCAT`）；
  没写厂家时几家都有就优先 SCHOTT；模型玻璃 `516800.6417` / `1.5168:64.17` → `___BLANK` 1.5168 / 64.17；
  文件里 `PRV` 定义的折射率表 → 拟合成模型玻璃 nd / vd。
- **口径**：`CIR` → 固定半口径 + `CLAP`，`CIR OBS` → `OBSC`，`ADX ADY` → `OBDC`。
- **位置求解**：`THI Sk OAL Sj..k+1 len` → 面 k 的 `TOLE j len`，该面不写多重结构厚度。
- **多重结构**：`ZOO n` → `MNUM n`；`TIT Zk` → `LTTL`；`ZOO THI / CUY / RDY / K / A…J / CIR / XDE…` →
  `THIC`（`THC 0` 的标成变量）`/ CRVT / CONN / PRAM 或 EDVA / SDIA / PRAM`；`ZOO EPD / FNO / NAO` → `APER`；
  `ZOO YAN… / WTF / VUY…` → `YFIE XFIE FLWT FVDY FVCY FVDX FVCX`；`ZOO WL / WTW / REF / TEM / PRE` →
  `WAVE WLWT PWAV TEMP PRES`。只写各结构确实不同的行。`CIR` 随结构变化时 `CLAP` 取最大值，
  免得某个结构被提前挡光。
- **和宏写的 `.zmx` 不同的两处**：孔径是 `FNUM v 1`（宏写 `FNUM v 0`，像方 F/#，有限共轭时会差一点）；
  光线瞄准开成实际光线瞄准 `RAIM 0 2`（CODE V 本来就按实际光线对准光阑，宏写的是关闭）。

### 带不过去的东西

每一条都会报警告，并写进 `.zmx` 的 `NOTE`：

- 不在哑面上的偏心/倾斜，`DAR` `BEN` `REV`
- 矩形、椭圆口径，`CIR HOL`（中心孔）
- `ZOO GLA`（玻璃随结构变化）等没有 Zemax 写法的多重结构项
- 映射表里没有的玻璃：按 CODE V 名字写出（去掉 `_厂家`），Zemax 打开会标成未知玻璃
- 用公式定义的私有玻璃（只认折射率表）
- `SPS` 里 `ODD` 以外的特殊面、`HCT` 不是 `R` 的衍射面
- 拾取（`PIK`）和 OAL 以外的求解（比如 `PIM`）按文件里的当前值写出，不联动；公差、面上的优化变量（`CCY` `THC`）不转换

### 已验证

- `npm test`：seq2zmx 16 项自动测试。样本有按 CODE V 2026 导出格式手写的 3 档变焦（`&` 续行、`!` 注释、
  OAL 求解、H/J 高次非球面、CDGM / HOYA 牌号、模型玻璃、变焦渐晕），私有玻璃、DOE、坐标断点、反射镜、
  有限共轭 F 数、中文标题等。
- **往返**：三个 `.zmx` 测试样本 → zmx2seq → seq2zmx → 与原文件比对：每个面 4 个高度的矢高、厚度、光阑、玻璃、
  通光口径、位置求解，视场、渐晕、波长、权重（按比例）、孔径，以及每一条多重结构数据全部一致。
  例外只有设计如此的几处：无限远时像方 F/# 变成同值的近轴工作 F/#、随结构变化的 `CLAP` 取最大值、
  映射表里没有的玻璃、环形面（zmx2seq 那一步就只写了基础曲率）。
- **第三方读取**：rayoptics 自带的 29 个 CODE V `.seq` 样本全部能转。rayoptics 再分别读原 `.seq` 和转出的 `.zmx`：
  它能读的 26 个逐面矢高、厚度一致（DOE 面差 1.6e-5 mm，是 rayoptics 不读 Binary 2 的非球面参数）；
  另外 3 个是 rayoptics 自己读不了 `.zmx`（两个带偏心的反射系统，一个用了它不认识的 OHARA 目录名）。
- **近轴 EFL**：seq2zmx 写在 `NOTE` 里的 EFL（折射率由 nd/vd 近似）和 rayoptics 直接读 `.seq` 算的，
  玻璃都查得到的样本相差 0.3% 以内（例如 13.104 / 13.106、100.004 / 100.004；反射系统两边的正负号约定相反）。不一样的三个：
  DOE 样本（rayoptics 不算衍射面的光焦度，它给的值和去掉 DOE 的版本一样）；
  `achroMangin`（老牌号 SK19、KZFS4 不在映射表里，已报警告）；
  `CODV_65564`（rayoptics 1.4497，按 nd 手算 1.4989，和 seq2zmx 相同）。

**还没在 OpticStudio 里打开验证过。** 版式照搬已经实测过的宏，但第一次用请拿一个熟悉的镜头试一下：
`.zmx` 的 `NOTE` 里有每个结构的近轴 EFL，和 OpticStudio 的 Prescription Data 直接对；再看一眼多重结构和渐晕。

## 文件编码

`CV2ZMX.seq` 是 **GBK + CRLF**（注释里有中文）。用别的编辑器改完记得保持原编码，
或者把中文注释删掉改存 ASCII。`CV2ZMX_GLASS.DAT` 是纯 ASCII + CRLF，
每行五个空格分隔的字段，**不能有注释行或表头** —— 宏用无格式 `REA` 按空格切字段读它。

`web/`、`tools/`、`test/` 下的文件是 UTF-8 + LF（测试样本 `.zmx` 是 CRLF）。zmx2seq 写出的 `.seq` 是 CRLF，
默认 GBK 编码，纯 ASCII 内容时 GBK 和 UTF-8 完全一样。seq2zmx 读 `.seq` 时自动认 GBK / UTF-8 / UTF-16，
写出的 `.zmx` 是 CRLF，纯 ASCII，有中文时 UTF-16LE 带 BOM。

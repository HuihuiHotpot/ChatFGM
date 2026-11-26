"""绘制瞬态着火剖面的最高温度和整体化学放热率。"""

import argparse
import json
from pathlib import Path
import re

import h5py
from matplotlib import rc_context
from matplotlib.figure import Figure
from matplotlib.ticker import MaxNLocator
import numpy as np


def create_sampling_figure(show_detail):
    rows = 2 if show_detail else 1
    height_mm = 108 if show_detail else 57
    figure = Figure(figsize=(116 / 25.4, height_mm / 25.4))
    figure.subplots_adjust(left=0.15, right=0.965, top=0.93 if show_detail else 0.87,
                           bottom=0.11 if show_detail else 0.20, hspace=0.59)
    return figure, figure.subplots(rows, squeeze=False)[:, 0]


def draw_saved_profiles(ax, times, values, label, title, count):
    ax.plot(times, values, "o-", color="#0072B2", linewidth=0.75, markersize=3.0,
            markeredgecolor="white", markeredgewidth=0.35)
    ax.set(xlabel="Save time (ms)", ylabel=label)
    ax.yaxis.set_label_coords(-0.11, 0.5)
    ax.set_title(title, loc="left", fontsize=8, fontweight="medium")
    ax.set_title(count, loc="right", fontsize=7.5, color="#546773")

    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#788892")
    ax.tick_params(direction="out", length=2.5, width=0.55, pad=3, color="#788892")
    ax.grid(axis="y", color="#DDE4E8", linewidth=0.48)
    ax.set_axisbelow(True)
    ax.margins(x=0.045, y=0.08)
    ax.xaxis.set_major_locator(MaxNLocator(nbins=5))
    ax.yaxis.set_major_locator(MaxNLocator(nbins=5))


def read_saved_profiles(directory):
    frames = []
    for path in directory.iterdir():
        if path.is_file() and re.fullmatch(r"prof[0-9]+\.h5", path.name):
            with h5py.File(path) as profile:
                time = float(profile["t"][()]) * 1000.0
                tmax = float(np.max(profile["T"][()]))
            if not np.isfinite([time, tmax]).all():
                raise ValueError(f"{path.name} 的积分时间或最高温度不是有限数值")
            frames.append((time, tmax, path))
    if not frames:
        raise ValueError(f"目录中没有编号剖面：{directory}")
    return sorted(frames, key=lambda frame: (frame[0], frame[2].name))


def plot_temperature(frames, output):
    times, temperatures, _ = zip(*frames)
    times = np.asarray(times)
    temperatures = np.asarray(temperatures)
    rise = temperatures.max() - temperatures[0]
    figure, axes = create_sampling_figure(show_detail=rise > 0)
    label = r"$T_{\max}$ (K)"
    draw_saved_profiles(axes[0], times, temperatures, label, "Full history", f"{times.size} saved profiles")

    count = None
    if rise > 0:
        low, high = temperatures[0] + rise * np.array([0.1, 0.9])
        first = int(np.flatnonzero(temperatures >= low)[0])
        last = int(np.flatnonzero(temperatures >= high)[0])
        inside = temperatures[first:last + 1]
        count = int(np.count_nonzero((inside >= low) & (inside <= high)))

        detail = axes[1]
        region = slice(max(first - 1, 0), last + 2)
        draw_saved_profiles(detail, times[region], temperatures[region], label,
                            "10–90% temperature rise", f"{count} profiles within thresholds")
        for percent, threshold in ((10, low), (90, high)):
            detail.axhline(threshold, color="#889AA4", linestyle=(0, (4, 3)), linewidth=0.62, zorder=1.5)
            right = percent == 10
            detail.annotate(f"{percent}%", xy=(0.985 if right else 0.015, threshold),
                            xycoords=detail.get_yaxis_transform(), xytext=(0, 2.5),
                            textcoords="offset points", ha="right" if right else "left", va="bottom",
                            fontsize=7, color="#546773")

    figure.savefig(output, dpi=400)
    return count


def integrate_heat_release(x, q):
    """与 Ember 一致，在原始空间网格上积分自然三次样条。"""
    if x.ndim != 1 or x.size < 2 or q.shape != x.shape:
        raise ValueError("x 和 q 须为等长的一维剖面，且至少包含两个空间点")
    widths = np.diff(x)
    if not np.isfinite(x).all() or not np.isfinite(q).all() or not np.all(widths > 0):
        raise ValueError("x 须有限且严格递增，q 须为有限数值")

    # 求自然三次样条内节点的二阶导数，两端的二阶导数为零。
    diagonal = 2 * (widths[:-1] + widths[1:])
    rhs = 6 * np.diff(np.diff(q) / widths)
    for index, off_diagonal in enumerate(widths[1:-1], start=1):
        ratio = off_diagonal / diagonal[index - 1]
        diagonal[index] -= ratio * off_diagonal
        rhs[index] -= ratio * rhs[index - 1]
    curvature = np.zeros(x.size)
    for index in range(diagonal.size - 1, -1, -1):
        curvature[index + 1] = (rhs[index] - widths[index + 1] * curvature[index + 2]) / diagonal[index]

    # 每段样条的解析积分等于梯形面积加上内部曲率修正。
    trapezoids = 0.5 * widths * (q[:-1] + q[1:])
    correction = widths ** 3 * (curvature[:-1] + curvature[1:]) / 24
    return float(np.sum(trapezoids - correction))


def plot_heat_release(frames, output):
    times = np.asarray([time for time, _, _ in frames])
    heat_release = []
    for _, _, path in frames:
        try:
            with h5py.File(path, "r") as profile:
                heat_release.append(integrate_heat_release(profile["x"][()], profile["q"][()]))
        except (KeyError, ValueError) as exc:
            raise ValueError(f"{path.name}：{exc}") from exc
    heat_release = np.asarray(heat_release)
    peak = int(np.argmax(heat_release))
    zoom = peak > 0 and times.size > 2
    values = heat_release / 1e6

    figure, axes = create_sampling_figure(show_detail=zoom)
    label = r"$Q$ (MW/m$^2$)"
    draw_saved_profiles(axes[0], times, values, label, "Full history", f"{times.size} saved profiles")

    if zoom:
        half_peak = (heat_release[0] + heat_release[peak]) / 2
        before = np.flatnonzero(heat_release[:peak] < half_peak)
        after = np.flatnonzero(heat_release[peak + 1:] < half_peak)
        start = int(before[-1]) if before.size else 0
        stop = peak + 2 + int(after[0]) if after.size else times.size

        detail = axes[1]
        region = slice(start, stop)
        draw_saved_profiles(detail, times[region], values[region], label,
                            "Heat-release peak region", f"{stop - start} saved profiles")
        low, high = detail.get_ylim()
        detail.set_ylim(low, high + 0.25 * (high - low))
        midpoint = (times[start] + times[stop - 1]) / 2
        side = 1 if times[peak] <= midpoint else -1
        detail.annotate(f"{values[peak]:.2f} MW/m²  ·  {times[peak]:.3f} ms",
                        xy=(times[peak], values[peak]), xytext=(side * 15, 12),
                        textcoords="offset points", ha="left" if side > 0 else "right", va="bottom",
                        fontsize=7, color="#3E515D",
                        bbox={"facecolor": "white", "edgecolor": "none", "pad": 1.0},
                        arrowprops={"arrowstyle": "-|>", "color": "#536B79", "linewidth": 0.85,
                                    "mutation_scale": 9, "relpos": (0 if side > 0 else 1, 0),
                                    "shrinkA": 2, "shrinkB": 2.7})

    figure.savefig(output, dpi=400)
    return {
        "heat_release_plot": str(output),
        "peak_heat_release_w_m2": float(heat_release[peak]),
        "peak_time_ms": float(times[peak]),
    }


@rc_context({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 8,
    "text.color": "#263540",
    "axes.labelcolor": "#263540",
    "xtick.labelcolor": "#263540",
    "ytick.labelcolor": "#263540",
    "axes.linewidth": 0.55,
    "axes.labelpad": 3,
    "axes.titlesize": 7,
    "axes.titlepad": 5,
    "mathtext.fontset": "dejavusans",
})
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="单个瞬态着火工况目录")
    parser.add_argument("--output", type=Path, help="图片目录，默认使用输入目录")
    args = parser.parse_args()

    try:
        frames = read_saved_profiles(args.input)
        output = args.output or args.input
        output.mkdir(parents=True, exist_ok=True)
        tmax_path = output / "profile_sampling_tmax.png"
        summary = {
            "tmax_plot": str(tmax_path),
            "total_frames": len(frames),
            "rise_10_to_90_frames": plot_temperature(frames, tmax_path),
        }
        summary.update(plot_heat_release(frames, output / "profile_sampling_heat_release.png"))
    except (OSError, KeyError, ValueError) as exc:
        parser.exit(1, f"采样绘图失败：{exc}\n")

    print(json.dumps(summary))


if __name__ == "__main__":
    main()

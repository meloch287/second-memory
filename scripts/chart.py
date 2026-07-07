#!/usr/bin/env python3
"""Рендер графика по JSON-спецификации из stdin -> PNG в путь из argv[1].

Спецификация:
{
  "type": "bar" | "line" | "pie",
  "title": "...",
  "xlabel": "...", "ylabel": "...",
  "labels": ["Янв", "Фев", ...],
  "series": [{"name": "Траты", "values": [1, 2, ...]}, ...]
}
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

PALETTE = ["#2454E8", "#E8642C", "#1FA97C", "#B3261E", "#7B5CD6", "#C79A00"]


def main() -> None:
    spec = json.load(sys.stdin)
    out = sys.argv[1]
    kind = spec.get("type", "bar")
    labels = [str(x) for x in spec.get("labels", [])]
    series = spec.get("series", [])

    fig, ax = plt.subplots(figsize=(9, 5.5), dpi=140)
    fig.patch.set_facecolor("white")

    if kind == "pie" and series:
        values = series[0].get("values", [])
        ax.pie(
            values,
            labels=labels,
            autopct="%1.0f%%",
            colors=PALETTE * (len(values) // len(PALETTE) + 1),
            textprops={"fontsize": 11},
        )
        ax.axis("equal")
    elif kind == "line":
        for i, s in enumerate(series):
            ax.plot(
                labels,
                s.get("values", []),
                marker="o",
                linewidth=2.2,
                color=PALETTE[i % len(PALETTE)],
                label=s.get("name", ""),
            )
        ax.grid(True, alpha=0.25)
    else:  # bar
        n = max(len(series), 1)
        width = 0.8 / n
        for i, s in enumerate(series):
            xs = [j + i * width - 0.4 + width / 2 for j in range(len(labels))]
            ax.bar(
                xs,
                s.get("values", []),
                width=width,
                color=PALETTE[i % len(PALETTE)],
                label=s.get("name", ""),
            )
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, rotation=25, ha="right", fontsize=10)
        ax.grid(True, axis="y", alpha=0.25)

    if spec.get("title"):
        ax.set_title(spec["title"], fontsize=14, pad=12)
    if spec.get("xlabel"):
        ax.set_xlabel(spec["xlabel"], fontsize=11)
    if spec.get("ylabel"):
        ax.set_ylabel(spec["ylabel"], fontsize=11)
    if kind != "pie" and sum(1 for s in series if s.get("name")) > 1:
        ax.legend(fontsize=10)

    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)

    fig.tight_layout()
    fig.savefig(out, format="png", bbox_inches="tight")


if __name__ == "__main__":
    main()

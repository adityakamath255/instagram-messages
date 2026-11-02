import {
  Chart,
  registerables,
  type ChartConfiguration,
} from "chart.js";
import {
  css,
  html,
  LitElement,
  type PropertyValues,
} from "lit";

Chart.register(...registerables);

export interface ChartDatum {
  readonly label: string;
  readonly value: number;
}

export interface ChartDataset {
  readonly label: string;
  readonly data: readonly ChartDatum[];
  readonly tone: "primary" | "secondary" | "tertiary";
}

export interface ChartSpec {
  readonly title: string;
  readonly kind: "bar" | "line";
  // entries align by position across datasets; labels come from the first
  // dataset and need not be unique.
  readonly datasets: readonly [ChartDataset, ...ChartDataset[]];
  readonly horizontal?: boolean;
}

interface Theme {
  readonly background: string;
  readonly foreground: string;
  readonly grid: string;
  readonly muted: string;
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
}

function theme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color("--paper"),
    foreground: color("--ink"),
    grid: color("--chart-grid"),
    muted: color("--smoke"),
    primary: color("--lilac"),
    secondary: color("--coral"),
    tertiary: color("--violet"),
  };
}

export function configuration(spec: ChartSpec): ChartConfiguration {
  const colors = theme();
  const labels = spec.datasets[0].data.map(({ label }) => label);
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  return {
    type: spec.kind,
    data: {
      labels,
      datasets: spec.datasets.map((dataset) => ({
        label: dataset.label,
        data: dataset.data.map(({ value }) => value),
        backgroundColor: colors[dataset.tone],
        borderColor: colors[dataset.tone],
        borderWidth: spec.kind === "line" ? 2 : 0,
        borderRadius: spec.kind === "bar" ? 3 : 0,
        pointRadius: spec.kind === "line" ? 0 : undefined,
        pointHitRadius: spec.kind === "line" ? 8 : undefined,
        tension: spec.kind === "line" ? 0.18 : undefined,
      })),
    },
    options: {
      animation: reducedMotion ? false : { duration: 280 },
      indexAxis: spec.horizontal ? "y" : "x",
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: {
          display: spec.datasets.length > 1,
          labels: {
            boxHeight: 8,
            boxWidth: 8,
            color: colors.muted,
            usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: colors.background,
          bodyColor: colors.foreground,
          titleColor: colors.foreground,
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: colors.grid },
          ticks: {
            color: colors.muted,
            maxRotation: spec.horizontal ? 0 : 45,
            minRotation: 0,
          },
        },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: colors.grid },
          ticks: { color: colors.muted },
        },
      },
    },
  };
}

export class ArchiveChart extends LitElement {
  static override properties = {
    spec: { attribute: false },
  };

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    canvas {
      width: 100%;
      height: 100%;
    }
  `;

  declare spec: ChartSpec | null;
  #chart: Chart | null = null;

  constructor() {
    super();
    this.spec = null;
  }

  override render() {
    return html`
      <canvas
        role="img"
        aria-label=${this.spec?.title ?? "Chart"}
      ></canvas>
    `;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("spec")) return;
    this.#chart?.destroy();
    const canvas = this.renderRoot.querySelector("canvas");
    this.#chart = this.spec && canvas
      ? new Chart(canvas, configuration(this.spec))
      : null;
  }

  override disconnectedCallback(): void {
    this.#chart?.destroy();
    this.#chart = null;
    super.disconnectedCallback();
  }
}

customElements.define("archive-chart", ArchiveChart);

declare global {
  interface HTMLElementTagNameMap {
    "archive-chart": ArchiveChart;
  }
}

import "./styles.css";
import "./charts.ts";

import {
  html,
  LitElement,
  nothing,
  type TemplateResult,
} from "lit";
import { guard } from "lit/directives/guard.js";

import type { ChartSpec } from "./charts.ts";
import {
  ExportError,
  InstagramArchive,
  metrics,
  trends,
  type ConversationSummary,
  type FollowGroup,
  type FollowNetwork,
  type LoadProgress,
  type MessageReport,
  type Metric,
  type Trend,
} from "./archive.ts";

type OverviewPage = {
  readonly kind: "overview";
  readonly metric: Metric;
};

type ConversationPage = {
  readonly kind: "conversation";
  readonly conversation: ConversationSummary;
  readonly metric: Metric;
  readonly trend: Trend;
};

type FollowPage = {
  readonly kind: "follows";
  readonly group: FollowGroup;
};

type Page = OverviewPage | ConversationPage | FollowPage;

type AppState =
  | { readonly kind: "empty" }
  | {
      readonly kind: "loading";
      readonly sources: readonly string[];
      readonly progress: LoadProgress | null;
    }
  | { readonly kind: "error"; readonly message: string }
  | ReadyState;

type ReadyState = {
  readonly kind: "ready";
  readonly archive: InstagramArchive;
  readonly page: Page;
};

const initialMessagePage: OverviewPage = {
  kind: "overview",
  metric: "Messages",
};
const initialFollowPage: FollowPage = {
  kind: "follows",
  group: "mutual",
};

const followGroups = {
  mutual: "Mutual",
  "you-follow": "You follow, no follow-back",
  "follows-you": "Follows you, not followed back",
} satisfies Record<FollowGroup, string>;

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatted(value: number): string {
  return numberFormat.format(value);
}

function selectedValue(event: Event): string | null {
  return event.currentTarget instanceof HTMLSelectElement
    ? event.currentTarget.value
    : null;
}

function selectedKey<Key extends string>(
  event: Event,
  choices: Readonly<Record<Key, unknown>>,
): Key | null {
  const value = selectedValue(event);
  return value !== null && Object.hasOwn(choices, value)
    ? value as Key
    : null;
}

export class InstagramArchiveApp extends LitElement {
  #state: AppState = { kind: "empty" };

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override render(): TemplateResult {
    switch (this.#state.kind) {
      case "empty":
        return this.uploadPage();
      case "error":
        return this.uploadPage(this.#state.message);
      case "loading":
        return this.loadingPage(this.#state.sources, this.#state.progress);
      case "ready":
        return this.readyPage(this.#state.archive, this.#state.page);
    }
  }

  private uploadControl(
    label: string,
    appearance: "primary" | "quiet" = "primary",
  ): TemplateResult {
    return html`
      <label class="button button--${appearance}">
        ${label}
        <input
          class="visually-hidden"
          type="file"
          accept=".zip,application/zip"
          multiple
          @change=${this.openFiles}
        />
      </label>
    `;
  }

  private uploadPage(message?: string): TemplateResult {
    return html`
      <div class="upload-shell">
        <section class="upload-copy">
          <p class="eyebrow">Private archive reader</p>
          <h1>See the conversations inside your export.</h1>
          <p class="lede">
            Choose the ZIP files Instagram gave you. The archive stays in this
            browser and disappears when you close the page.
          </p>
          ${this.uploadControl(
            message ? "Choose another export" : "Choose export ZIP",
          )}
          ${message
            ? html`<p class="error" role="alert">${message}</p>`
            : nothing}
          <p class="privacy-note">
            No account login. No upload. JSON exports only.
          </p>
        </section>
        ${this.manifest("waiting")}
      </div>
    `;
  }

  private loadingPage(
    sources: readonly string[],
    progress: LoadProgress | null,
  ): TemplateResult {
    const detail = progress
      ? `Archive ${progress.archive} of ${sources.length} · ${formatted(
          progress.files,
        )} files read`
      : "Opening archive…";
    return html`
      <div class="upload-shell">
        <section class="upload-copy">
          <p class="eyebrow">Reading locally</p>
          <h1>Your archive is being indexed.</h1>
          <p class="lede file-list">${sources.join(" · ")}</p>
          <p class="progress" role="status" aria-live="polite">${detail}</p>
          <div class="scan-line" aria-hidden="true"><span></span></div>
        </section>
        ${this.manifest("reading")}
      </div>
    `;
  }

  private manifest(
    status: "waiting" | "reading" | "ready",
    archive?: InstagramArchive,
  ): TemplateResult {
    const follows = archive?.follows;
    const unavailable = archive ? "not included" : status;
    const rows = [
      [
        "personal_information/",
        archive?.hasMessages ? "profile found" : unavailable,
      ],
      [
        "messages/inbox/",
        archive?.hasMessages
          ? `${formatted(archive.messageCount)} messages`
          : unavailable,
      ],
      [
        "followers_and_following/",
        follows
          ? `${formatted(follows.followerCount)} in · ${formatted(
              follows.followingCount,
            )} out`
          : unavailable,
      ],
    ] as const;
    return html`
      <section class="manifest" aria-label="Archive contents">
        <div class="manifest__head">
          <span>Archive manifest</span>
          <span>${status}</span>
        </div>
        ${rows.map(([path, value]) => html`
          <div class="manifest__row">
            <code>${path}</code>
            <span class="manifest__status manifest__status--${status}">
              ${value}
            </span>
          </div>
        `)}
      </section>
    `;
  }

  private readyPage(
    archive: InstagramArchive,
    page: Page,
  ): TemplateResult {
    return html`
      <div class="app-shell">
        <header class="topbar">
          <div class="wordmark">
            <span aria-hidden="true">↳</span> Instagram archive
          </div>
          ${this.uploadControl("Open another", "quiet")}
        </header>
        <section class="dataset">
          <div>
            <span>Loaded locally</span>
            <strong title=${archive.sources.join(" · ")}>
              ${archive.sources.join(" · ")}
            </strong>
          </div>
          ${this.manifest("ready", archive)}
        </section>
        <nav class="view-tabs" aria-label="Archive view">
          ${archive.hasMessages
            ? html`
                <button
                  aria-current=${page.kind === "follows" ? nothing : "page"}
                  @click=${() => this.show(archive, initialMessagePage)}
                >Messages</button>
              `
            : nothing}
          ${archive.follows
            ? html`
                <button
                  aria-current=${page.kind === "follows" ? "page" : nothing}
                  @click=${() => this.show(archive, initialFollowPage)}
                >Follows</button>
              `
            : nothing}
        </nav>
        <main class="report">
          ${page.kind === "follows"
            ? archive.follows
              ? this.followView(archive, archive.follows, page)
              : nothing
            : this.messageView(archive, page)}
        </main>
        <footer>
          Processed in this browser. Reloading clears the archive.
        </footer>
      </div>
    `;
  }

  private messageView(
    archive: InstagramArchive,
    page: OverviewPage | ConversationPage,
  ): TemplateResult {
    const conversation = page.kind === "conversation"
      ? page.conversation
      : null;
    const report = conversation
      ? conversation.report(page.metric)
      : archive.overview(page.metric);
    const total = report.byAuthor.self + report.byAuthor.other;
    return html`
      <section class="report-head">
        <div>
          <p class="eyebrow">
            ${conversation ? "One conversation" : "All conversations"}
          </p>
          <h2>${conversation?.person ?? "Message patterns"}</h2>
          <p>${formatted(total)} ${page.metric} in this view</p>
        </div>
        ${conversation
          ? html`
              <div class="split-counts" aria-label="Conversation totals">
                <div>
                  <span>You</span>
                  <strong>${formatted(report.byAuthor.self)}</strong>
                </div>
                <div>
                  <span>${conversation.person}</span>
                  <strong>${formatted(report.byAuthor.other)}</strong>
                </div>
              </div>
            `
          : nothing}
      </section>
      ${this.messageControls(archive, page)}
      <div class="card-grid">
        ${page.kind === "overview"
          ? guard([archive, page.metric], () =>
              this.peopleChart(archive, page.metric))
          : nothing}
        ${guard([archive, conversation, page.metric], () => this.chartCard({
          title: `${page.metric} by hour`,
          kind: "bar",
          datasets: [{
            label: page.metric,
            data: report.byHour,
            tone: "primary",
          }],
        }, "Your local time"))}
        ${guard([archive, conversation, page.metric], () => this.chartCard({
          title: `${page.metric} by weekday`,
          kind: "bar",
          datasets: [{
            label: page.metric,
            data: report.byWeekday,
            tone: "tertiary",
          }],
        }, "Monday through Sunday"))}
        ${page.kind === "conversation"
          ? guard(
              [archive, conversation, page.metric, page.trend],
              () => this.trendChart(report, page),
            )
          : nothing}
        ${report.reactions.length
          ? guard(
              [archive, conversation],
              () => this.reactionChart(report.reactions),
            )
          : this.emptyCard("Top reactions", "No reactions in this selection.")}
      </div>
    `;
  }

  private messageControls(
    archive: InstagramArchive,
    page: OverviewPage | ConversationPage,
  ): TemplateResult {
    const conversationId = page.kind === "conversation"
      ? page.conversation.id
      : "";
    return html`
      <section class="controls" aria-label="Message report controls">
        <label class="control">
          <span>Conversation</span>
          <select
            @change=${(event: Event) =>
              this.changeConversation(event, archive, page)}
          >
            <option value="" ?selected=${page.kind === "overview"}>
              Everyone
            </option>
            ${archive.conversations.map((conversation) => html`
              <option
                value=${conversation.id}
                ?selected=${conversation.id === conversationId}
              >
                ${conversation.person} · ${formatted(
                  conversation.messageCount,
                )}
              </option>
            `)}
          </select>
        </label>
        <label class="control">
          <span>Count</span>
          <select
            @change=${(event: Event) =>
              this.changeMetric(event, archive, page)}
          >
            ${Object.keys(metrics).map((value) => html`
              <option value=${value} ?selected=${value === page.metric}>
                ${value}
              </option>
            `)}
          </select>
        </label>
        ${page.kind === "conversation"
          ? html`
              <label class="control">
                <span>Over time</span>
                <select
                  @change=${(event: Event) =>
                    this.changeTrend(event, archive, page)}
                >
                  ${Object.keys(trends).map((value) => html`
                    <option value=${value} ?selected=${value === page.trend}>
                      ${value}
                    </option>
                  `)}
                </select>
              </label>
            `
          : nothing}
      </section>
    `;
  }

  private peopleChart(
    archive: InstagramArchive,
    metric: Metric,
  ): TemplateResult {
    const spec: ChartSpec = {
      title: `${metric} by person`,
      kind: "bar",
      horizontal: true,
      datasets: [{
        label: metric,
        data: archive.overview(metric).conversationTotals,
        tone: "primary",
      }],
    };
    return this.chartCard(spec, "Top 25 one-to-one conversations", "tall");
  }

  private trendChart(
    report: MessageReport,
    page: ConversationPage,
  ): TemplateResult {
    const trend = trends[page.trend](report);
    const spec: ChartSpec = {
      title: `${page.metric} over time`,
      kind: "line",
      datasets: [{
        label: page.metric,
        data: trend,
        tone: "primary",
      }],
    };
    return this.chartCard(spec, page.trend, "wide");
  }

  private reactionChart(
    reactions: MessageReport["reactions"],
  ): TemplateResult {
    const spec: ChartSpec = {
      title: "Top reactions",
      kind: "bar",
      datasets: [
        {
          label: "You",
          data: reactions.map(({ emoji, self }) => ({
            label: emoji,
            value: self,
          })),
          tone: "primary",
        },
        {
          label: "Them",
          data: reactions.map(({ emoji, other }) => ({
            label: emoji,
            value: other,
          })),
          tone: "secondary",
        },
      ],
    };
    return this.chartCard(spec, "Grouped by who reacted", "wide");
  }

  private chartCard(
    spec: ChartSpec,
    caption: string,
    size: "normal" | "wide" | "tall" = "normal",
  ): TemplateResult {
    return html`
      <section class="card card--${size}">
        <header class="card__head">
          <h3>${spec.title}</h3>
          <p>${caption}</p>
        </header>
        <div class="chart"><archive-chart .spec=${spec}></archive-chart></div>
      </section>
    `;
  }

  private emptyCard(title: string, message: string): TemplateResult {
    return html`
      <section class="card card--wide card--empty">
        <h3>${title}</h3>
        <p>${message}</p>
      </section>
    `;
  }

  private followView(
    archive: InstagramArchive,
    follows: FollowNetwork,
    page: FollowPage,
  ): TemplateResult {
    const group = [...follows.group(page.group)].sort((left, right) =>
      left.username.localeCompare(right.username)
    );
    return html`
      <section class="report-head">
        <div>
          <p class="eyebrow">Follow relationships</p>
          <h2>${followGroups[page.group]}</h2>
          <p>${formatted(group.length)} accounts in this group</p>
        </div>
      </section>
      <section class="controls" aria-label="Follow report controls">
        <label class="control">
          <span>Relationship</span>
          <select
            @change=${(event: Event) =>
              this.changeFollowGroup(event, archive)}
          >
            ${Object.entries(followGroups).map(([value, label]) => html`
              <option value=${value} ?selected=${value === page.group}>
                ${label}
              </option>
            `)}
          </select>
        </label>
      </section>
      <section class="table-card">
        ${group.length
          ? html`
              <table>
                <thead><tr><th>Account</th><th>Since</th></tr></thead>
                <tbody>
                  ${group.map((follow) => html`
                    <tr>
                      <td>
                        <a
                          href=${`https://www.instagram.com/${encodeURIComponent(
                            follow.username,
                          )}/`}
                          target="_blank"
                          rel="noreferrer"
                        >@${follow.username}</a>
                      </td>
                      <td>${dateFormat.format(new Date(follow.followedAt))}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `
          : html`<p class="empty-table">No accounts in this group.</p>`}
      </section>
    `;
  }

  private show(archive: InstagramArchive, page: Page): void {
    this.setState({ kind: "ready", archive, page });
  }

  private changeConversation(
    event: Event,
    archive: InstagramArchive,
    page: OverviewPage | ConversationPage,
  ): void {
    const id = selectedValue(event);
    if (id === null) return;
    if (!id) {
      this.show(archive, { kind: "overview", metric: page.metric });
      return;
    }
    const conversation = archive.conversation(id);
    if (!conversation) return;
    this.show(archive, {
      kind: "conversation",
      conversation,
      metric: page.metric,
      trend: page.kind === "conversation" ? page.trend : "Monthly",
    });
  }

  private changeMetric(
    event: Event,
    archive: InstagramArchive,
    page: OverviewPage | ConversationPage,
  ): void {
    const metric = selectedKey(event, metrics);
    if (metric) this.show(archive, { ...page, metric });
  }

  private changeTrend(
    event: Event,
    archive: InstagramArchive,
    page: ConversationPage,
  ): void {
    const trend = selectedKey(event, trends);
    if (trend) this.show(archive, { ...page, trend });
  }

  private changeFollowGroup(
    event: Event,
    archive: InstagramArchive,
  ): void {
    const group = selectedKey(event, followGroups);
    if (!group) return;
    this.show(archive, {
      kind: "follows",
      group,
    });
  }

  private async openFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const sources = files.map(({ name }) => name);
    this.setState({ kind: "loading", sources, progress: null });
    try {
      const archive = await InstagramArchive.open(files, (progress) => {
        this.setState({ kind: "loading", sources, progress });
      });
      this.setState({
        kind: "ready",
        archive,
        page: archive.hasMessages ? initialMessagePage : initialFollowPage,
      });
    } catch (error) {
      this.setState({
        kind: "error",
        message: error instanceof ExportError
          ? error.message
          : "The archive could not be read. Choose the original Instagram ZIP files.",
      });
    }
  }

  private setState(state: AppState): void {
    this.#state = state;
    this.requestUpdate();
  }
}

customElements.define("instagram-archive-app", InstagramArchiveApp);

declare global {
  interface HTMLElementTagNameMap {
    "instagram-archive-app": InstagramArchiveApp;
  }
}

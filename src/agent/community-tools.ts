/*
 * Community tools of Settings > Coding agents: read the Community: the posts of a ticker, of the home feed or of a
 * search, a post with its replies, and open a post in the Community panel. Read only: what is posted there is written
 * by its members.
 */
import { api, tickerCommunityId, type Comment, type Post, type PostType, type Sort } from "../data/community/api";
import { requestOpenPost } from "../data/community/notifications";
import { setActiveRailTab } from "../window/shell/app-dialogs";
import { AgentError, type AgentTool } from "./mcp";

const TYPES: PostType[] = ["idea", "analysis", "question", "postmortem"];
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

function postView(p: Post) {
  return {
    id: p.id,
    type: p.type,
    community: p.community.title,
    title: p.title,
    author: p.author ?? "[deleted]",
    ...(p.author_bot ? { bot: true } : {}),
    ...(p.author_record?.resolved ? { authorRecord: { resolved: p.author_record.resolved, hitPct: p.author_record.hit_pct, avgR: p.author_record.avg_r } } : {}),
    posted: day(p.created_at),
    useful: p.useful_count,
    replies: p.comment_count,
    excerpt: p.excerpt,
    ...(p.idea
      ? { idea: { direction: p.idea.direction, entry: p.idea.entry, stop: p.idea.stop, target: p.idea.target, expires: p.idea.expires, status: p.idea.status, resultR: p.idea.result_r } }
      : {}),
    ...(p.chart ? { chart: `${p.chart.symbol}, ${p.chart.interval}` } : {}),
  };
}

const commentView = (c: Comment) => ({
  id: c.id,
  ...(c.parent_id ? { replyTo: c.parent_id } : {}),
  author: c.author ?? "[deleted]",
  ...(c.by_op ? { byAuthor: true } : {}),
  ...(c.kind ? { kind: c.kind } : {}),
  posted: day(c.created_at),
  useful: c.useful_count,
  body: c.deleted || c.removed ? "[removed]" : c.body,
});

export function createCommunityTools(): AgentTool[] {
  return [
    {
      name: "list_community_posts",
      title: "List community posts",
      description:
        "Community posts (ideas with entry/stop/target and their outcome, analysis, questions, post-mortems): of a symbol's community (symbol), found by a search (query), or the home feed. " +
        "With a symbol, also its open ideas, positioning (long / short) and the outcome of its ideas of the last 90 days. sort: useful (default) or new; type: idea, analysis, question, postmortem.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          query: { type: "string" },
          type: { type: "string", enum: TYPES },
          sort: { type: "string", enum: ["useful", "new"] },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args) => {
        const type = args.type === undefined ? null : TYPES.find((t) => t === args.type);
        if (type === undefined) throw new AgentError(`"type": one of ${TYPES.join(", ")}.`);
        const sort: Sort = args.sort === "new" ? "new" : "useful";
        if (typeof args.query === "string" && args.query.trim()) {
          const r = await api.search(args.query.trim(), { types: type ? [type] : [], outcomes: [], posted: "any", minUseful: 0 });
          return { total: r.total, posts: r.results.map(postView) };
        }
        if (typeof args.symbol === "string" && args.symbol.trim()) {
          const ticker = args.symbol.trim().toUpperCase().split(":").pop()!;
          const id = tickerCommunityId(ticker);
          if (!id) throw new AgentError(`"${args.symbol}" is not a ticker.`);
          const [view, posts] = await Promise.all([api.ticker(ticker), api.posts(id, sort, 0, type)]);
          return {
            community: view.community.title,
            positioning: view.positioning,
            openIdeas: view.open_ideas.map((i) => ({ id: i.id, title: i.title, author: i.author, direction: i.idea.direction, entry: i.idea.entry, stop: i.idea.stop, target: i.idea.target, status: i.idea.status })),
            resolved90: { resolved: view.resolved90.resolved, hitPct: view.resolved90.hit_pct, avgR: view.resolved90.avg_r },
            posts: posts.posts.map(postView),
          };
        }
        const home = await api.home(sort, type);
        return { posts: home.posts.map(postView) };
      },
    },
    {
      name: "read_community_post",
      title: "Read a community post",
      description: "A community post with its full text, its idea's levels and outcome, and its replies.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) throw new AgentError('"id" is required: see list_community_posts.');
        const r = await api.post(id);
        return { ...postView(r.post), body: r.post.body, ...(r.post.answer_id ? { answerId: r.post.answer_id } : {}), replies: r.comments.map(commentView) };
      },
    },
    {
      name: "open_community_post",
      title: "Open a community post",
      description: "Show a community post in the Community panel; chart: true also opens its shared chart on the active chart.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, chart: { type: "boolean" } }, required: ["id"] },
      run: async (args) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) throw new AgentError('"id" is required: see list_community_posts.');
        setActiveRailTab("community");
        requestOpenPost(id, { openChart: args.chart === true });
        return { opened: id };
      },
    },
  ];
}

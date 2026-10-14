// POST /api/me/problem { message?, context? } : « J'ai un problème ». Le signalement est visible
// dans l'onglet Admin et envoyé par e-mail à l'admin (qui peut répondre directement au membre).

import { handle, json, readJson } from "../../_lib/http.js";
import { notify } from "../../_lib/notify.js";

export const onRequestPost = ({ request, env, data, waitUntil }) => handle(async () => {
  const body = await readJson(request);
  const report = await data.me.reportProblem({ message: body.message, context: body.context });
  waitUntil(notify(env, { kind: "problem_report", userId: data.me.user.id, toAdmin: true,
    payload: { message: report.message, context: report.context }, dedupe: `problem:${report.id}` }));
  return json({ received: true }, 201);
});

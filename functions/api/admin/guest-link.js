// Lien d'invité de l'admin (version 1.15.0), page publique /visite/<jeton>/ :
// GET : { link, created_at } ou { link: null } ; POST : nouveau lien (l'ancien cesse de marcher) ;
// DELETE : lien retiré.

import { handle, json } from "../../_lib/http.js";
import { admin } from "../../_lib/me.js";

const linkOf = (request, row) => (row
  ? { link: new URL(`/visite/${row.token}/`, request.url).href, created_at: row.created_at }
  : { link: null, created_at: null });

export const onRequestGet = ({ request, env, data }) => handle(async () =>
  json(linkOf(request, await admin(env).guestLink(data.me.user.id))));

export const onRequestPost = ({ request, env, data }) => handle(async () =>
  json(linkOf(request, await admin(env).createGuestLink(data.me.user.id)), 201));

export const onRequestDelete = ({ request, env, data }) => handle(async () =>
  json(linkOf(request, await admin(env).deleteGuestLink(data.me.user.id))));

// GET /api/me/stars : concerts mis de côté par le membre.

import { handle, json } from "../../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.stars()));

// GET /api/me/removed : concerts retirés par le membre (« Ne plus voir ce concert »).

import { handle, json } from "../../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.removedConcerts()));

// Appel à un service extérieur qui ne doit pas bloquer l'action principale : en cas d'échec,
// l'action est faite dans D1 et l'écart est signalé à l'écran ({ done: false, reason }).

export async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`Service extérieur : ${e?.message || e}`);
    return { done: false, reason: String(e?.message || e) };
  }
}

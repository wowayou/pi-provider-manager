export async function readApiResponse(response, fallbackMessage) {
  const data = await response.json();
  if (response.ok) return data;
  const error = new Error(data.error || fallbackMessage);
  error.status = response.status;
  throw error;
}

// Every target supplies its own revision in the payload. One POST returns the
// committed public snapshot or propagates the HTTP error to the active screen.
export async function postJson(route, payload, failureMessage) {
  const response = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readApiResponse(response, failureMessage);
}

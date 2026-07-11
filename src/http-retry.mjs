export async function withRefreshRetry(doRequest, refresh) {
  let res = await doRequest()
  if (res && res.status === 401) {
    const refreshed = await refresh()
    if (refreshed && refreshed.ok) {
      res = await doRequest()
    }
  }
  return res
}

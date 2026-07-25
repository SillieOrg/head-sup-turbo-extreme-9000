import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type HeadsUpList = {
  listId: string
  ownerUserId: string
  title: string
  wordCount: number
  currentVersion: string
  updatedAt: string
  words?: string[]
  checksum?: string
}

type OfflineList = {
  listId: string
  title: string
  words: string[]
  downloadedAt: string
}

type ApiError = {
  code?: string
  message?: string
}

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
const OFFLINE_LISTS_KEY = 'headsup_offline_lists'
const GAME_DURATION_SECONDS = 60

function normalizeApiBase(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function toWords(raw: string) {
  return raw
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
}

function shuffleWords(words: string[]) {
  const clone = [...words]
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = clone[i]
    clone[i] = clone[j]
    clone[j] = temp
  }
  return clone
}

async function readJsonOrNull(response: Response) {
  const text = await response.text()
  if (!text) {
    return null
  }
  return JSON.parse(text) as unknown
}

function App() {
  const [apiBaseInput, setApiBaseInput] = useState(DEFAULT_API_BASE)
  const [userIdInput, setUserIdInput] = useState('')
  const [title, setTitle] = useState('')
  const [wordsRaw, setWordsRaw] = useState('')
  const [lists, setLists] = useState<HeadsUpList[]>([])
  const [offlineLists, setOfflineLists] = useState<OfflineList[]>([])
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [editingListId, setEditingListId] = useState('')
  const [editingTitle, setEditingTitle] = useState('')
  const [editingWordsRaw, setEditingWordsRaw] = useState('')
  const [editingVersion, setEditingVersion] = useState('')
  const [loadingLists, setLoadingLists] = useState(false)
  const [savingList, setSavingList] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [searchTitle, setSearchTitle] = useState('')
  const [searchOwner, setSearchOwner] = useState('')
  const [selectedOfflineListId, setSelectedOfflineListId] = useState('')
  const [motionPermission, setMotionPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown')
  const [gameWords, setGameWords] = useState<string[]>([])
  const [gameIndex, setGameIndex] = useState(0)
  const [gameScore, setGameScore] = useState(0)
  const [gameSkips, setGameSkips] = useState(0)
  const [timeLeft, setTimeLeft] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [baselineBeta, setBaselineBeta] = useState<number | null>(null)
  const [lastTiltAt, setLastTiltAt] = useState(0)
  const [error, setError] = useState('')

  const apiBase = useMemo(() => normalizeApiBase(apiBaseInput), [apiBaseInput])
  const userId = userIdInput.trim()
  const currentWord = gameWords[gameIndex] ?? ''
  const selectedOfflineList = offlineLists.find((list) => list.listId === selectedOfflineListId) ?? null

  useEffect(() => {
    const savedApiBase = localStorage.getItem('headsup_api_base') ?? DEFAULT_API_BASE
    const savedUserId = localStorage.getItem('headsup_user_id') ?? ''
    const savedOfflineLists = localStorage.getItem(OFFLINE_LISTS_KEY)
    setApiBaseInput(savedApiBase)
    setUserIdInput(savedUserId)
    if (savedOfflineLists) {
      const parsed = JSON.parse(savedOfflineLists) as OfflineList[]
      setOfflineLists(parsed)
      if (parsed.length > 0) {
        setSelectedOfflineListId(parsed[0].listId)
      }
    }
  }, [])

  useEffect(() => {
    if (!playing) {
      return undefined
    }
    const timer = window.setInterval(() => {
      setTimeLeft((previous) => {
        if (previous <= 1) {
          setPlaying(false)
          return 0
        }
        return previous - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [playing])

  useEffect(() => {
    if (!playing) {
      return undefined
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.beta !== 'number') {
        return
      }
      if (baselineBeta === null) {
        setBaselineBeta(event.beta)
        return
      }

      const now = Date.now()
      if (now - lastTiltAt < 900) {
        return
      }

      const delta = event.beta - baselineBeta
      if (delta <= -18) {
        setLastTiltAt(now)
        setGameScore((previous) => previous + 1)
        setGameIndex((previous) => previous + 1)
      } else if (delta >= 18) {
        setLastTiltAt(now)
        setGameSkips((previous) => previous + 1)
        setGameIndex((previous) => previous + 1)
      }
    }

    window.addEventListener('deviceorientation', onOrientation)
    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [baselineBeta, lastTiltAt, playing])

  useEffect(() => {
    if (!playing) {
      return
    }
    if (gameIndex >= gameWords.length && gameWords.length > 0) {
      setPlaying(false)
    }
  }, [gameIndex, gameWords.length, playing])

  async function apiRequest(path: string, init?: RequestInit) {
    if (!apiBase) {
      throw new Error('Set API base URL first.')
    }
    const response = await fetch(`${apiBase}${path}`, init)
    const payload = (await readJsonOrNull(response)) as ApiError | null
    if (!response.ok) {
      const message = payload?.message ?? payload?.code ?? `Request failed: ${response.status}`
      throw new Error(message)
    }
    return payload
  }

  async function loadFavorites() {
    if (!userId) {
      setFavoriteIds(new Set())
      return
    }
    const payload = (await apiRequest('/favorites', {
      headers: { 'x-user-id': userId },
    })) as { listIds?: string[] } | null
    setFavoriteIds(new Set(payload?.listIds ?? []))
  }

  async function loadLists() {
    setError('')
    setLoadingLists(true)
    try {
      const queryParts: string[] = []
      if (searchTitle.trim()) {
        queryParts.push(`title=${encodeURIComponent(searchTitle.trim())}`)
      }
      if (searchOwner.trim()) {
        queryParts.push(`owner=${encodeURIComponent(searchOwner.trim())}`)
      }
      const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : ''
      const payload = (await apiRequest(`/lists${query}`)) as { items?: HeadsUpList[] } | null
      setLists(payload?.items ?? [])
      await loadFavorites()
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load lists.')
    } finally {
      setLoadingLists(false)
    }
  }

  async function handleCreateList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!userId) {
      setError('Set your user ID first.')
      return
    }
    const words = toWords(wordsRaw)
    if (title.trim().length === 0 || words.length === 0) {
      setError('Title and at least one word are required.')
      return
    }

    setError('')
    setSavingList(true)
    try {
      await apiRequest('/lists', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          title: title.trim(),
          words,
          checksum: `${Date.now()}`,
        }),
      })
      setTitle('')
      setWordsRaw('')
      await loadLists()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create list.')
    } finally {
      setSavingList(false)
    }
  }

  async function beginEdit(listId: string) {
    setError('')
    try {
      const payload = (await apiRequest(`/lists/${listId}`)) as HeadsUpList
      setEditingListId(listId)
      setEditingTitle(payload.title)
      setEditingWordsRaw((payload.words ?? []).join('\n'))
      setEditingVersion(payload.currentVersion)
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : 'Failed to load list.')
    }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingListId) {
      return
    }
    if (!userId) {
      setError('Set your user ID first.')
      return
    }
    const words = toWords(editingWordsRaw)
    if (editingTitle.trim().length === 0 || words.length === 0) {
      setError('Title and at least one word are required.')
      return
    }

    setError('')
    setSavingEdit(true)
    try {
      await apiRequest(`/lists/${editingListId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({
          title: editingTitle.trim(),
          words,
          baseVersion: editingVersion,
          checksum: `${Date.now()}`,
        }),
      })
      clearEdit()
      await loadLists()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update list.')
    } finally {
      setSavingEdit(false)
    }
  }

  function clearEdit() {
    setEditingListId('')
    setEditingTitle('')
    setEditingWordsRaw('')
    setEditingVersion('')
  }

  async function removeList(listId: string) {
    if (!userId) {
      setError('Set your user ID first.')
      return
    }
    setError('')
    try {
      await apiRequest(`/lists/${listId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      })
      await loadLists()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete list.')
    }
  }

  async function toggleFavorite(listId: string) {
    if (!userId) {
      setError('Set your user ID first.')
      return
    }
    const isFavorite = favoriteIds.has(listId)
    setError('')
    try {
      await apiRequest(`/favorites/${listId}`, {
        method: isFavorite ? 'DELETE' : 'POST',
        headers: { 'x-user-id': userId },
      })
      await loadFavorites()
    } catch (favoriteError) {
      setError(favoriteError instanceof Error ? favoriteError.message : 'Failed to update favorite.')
    }
  }

  async function downloadList(listId: string) {
    setError('')
    try {
      const payload = (await apiRequest(`/lists/${listId}`)) as HeadsUpList
      const words = payload.words ?? []
      if (words.length === 0) {
        throw new Error('List has no words to download.')
      }
      const updated: OfflineList[] = [
        ...offlineLists.filter((list) => list.listId !== payload.listId),
        {
          listId: payload.listId,
          title: payload.title,
          words,
          downloadedAt: new Date().toISOString(),
        },
      ]
      localStorage.setItem(OFFLINE_LISTS_KEY, JSON.stringify(updated))
      setOfflineLists(updated)
      if (!selectedOfflineListId) {
        setSelectedOfflineListId(payload.listId)
      }
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Failed to download list.')
    }
  }

  function removeOfflineList(listId: string) {
    const updated = offlineLists.filter((list) => list.listId !== listId)
    localStorage.setItem(OFFLINE_LISTS_KEY, JSON.stringify(updated))
    setOfflineLists(updated)
    if (selectedOfflineListId === listId) {
      setSelectedOfflineListId(updated[0]?.listId ?? '')
    }
  }

  async function requestMotionPermission() {
    try {
      const maybeRequest = (
        DeviceOrientationEvent as unknown as {
          requestPermission?: () => Promise<'granted' | 'denied'>
        }
      ).requestPermission

      if (typeof maybeRequest === 'function') {
        const result = await maybeRequest()
        setMotionPermission(result)
      } else {
        setMotionPermission('granted')
      }
    } catch {
      setMotionPermission('denied')
      setError('Motion permission was denied.')
    }
  }

  function startGame() {
    if (!selectedOfflineList || selectedOfflineList.words.length === 0) {
      setError('Select a downloaded list with words first.')
      return
    }
    setError('')
    setGameWords(shuffleWords(selectedOfflineList.words))
    setGameIndex(0)
    setGameScore(0)
    setGameSkips(0)
    setTimeLeft(GAME_DURATION_SECONDS)
    setBaselineBeta(null)
    setLastTiltAt(0)
    setPlaying(true)
  }

  function stopGame() {
    setPlaying(false)
  }

  function saveConnectionDetails() {
    localStorage.setItem('headsup_api_base', apiBase)
    localStorage.setItem('headsup_user_id', userId)
    setError('')
  }

  return (
    <main className="app">
      <header>
        <h1>Head Sup Turbo Extreme 9000</h1>
        <p>MVP frontend: list CRUD, favorites, offline packs, and gyroscope round.</p>
      </header>

      <section className="panel">
        <h2>Connection</h2>
        <label>
          API base URL
          <input
            value={apiBaseInput}
            onChange={(event) => setApiBaseInput(event.target.value)}
            placeholder="https://abc123.execute-api.eu-west-2.amazonaws.com"
          />
        </label>
        <label>
          User ID
          <input
            value={userIdInput}
            onChange={(event) => setUserIdInput(event.target.value)}
            placeholder="andy-device-01"
          />
        </label>
        <div className="row">
          <button type="button" onClick={saveConnectionDetails}>
            Save
          </button>
          <button type="button" onClick={loadLists} disabled={loadingLists}>
            {loadingLists ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Search</h2>
        <div className="row row-stretch">
          <label>
            Title contains
            <input value={searchTitle} onChange={(event) => setSearchTitle(event.target.value)} />
          </label>
          <label>
            Owner contains
            <input value={searchOwner} onChange={(event) => setSearchOwner(event.target.value)} />
          </label>
        </div>
        <button type="button" onClick={loadLists} disabled={loadingLists}>
          Apply filters
        </button>
      </section>

      <section className="panel">
        <h2>Create list</h2>
        <form onSubmit={handleCreateList}>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} />
          </label>
          <label>
            Words (one per line)
            <textarea value={wordsRaw} onChange={(event) => setWordsRaw(event.target.value)} rows={8} />
          </label>
          <button type="submit" disabled={savingList}>
            {savingList ? 'Saving...' : 'Create list'}
          </button>
        </form>
      </section>

      {editingListId ? (
        <section className="panel">
          <h2>Edit list</h2>
          <form onSubmit={submitEdit}>
            <label>
              Title
              <input
                value={editingTitle}
                onChange={(event) => setEditingTitle(event.target.value)}
                maxLength={60}
              />
            </label>
            <label>
              Words (one per line)
              <textarea
                value={editingWordsRaw}
                onChange={(event) => setEditingWordsRaw(event.target.value)}
                rows={8}
              />
            </label>
            <div className="row">
              <button type="submit" disabled={savingEdit}>
                {savingEdit ? 'Saving...' : 'Save update'}
              </button>
              <button type="button" onClick={clearEdit}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <h2>Game (Gyroscope)</h2>
        <label>
          Downloaded list
          <select
            value={selectedOfflineListId}
            onChange={(event) => setSelectedOfflineListId(event.target.value)}
          >
            <option value="">Select list</option>
            {offlineLists.map((list) => (
              <option key={list.listId} value={list.listId}>
                {list.title} ({list.words.length} words)
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button type="button" onClick={requestMotionPermission}>
            {motionPermission === 'granted' ? 'Motion ready' : 'Enable motion'}
          </button>
          {!playing ? (
            <button type="button" onClick={startGame}>
              Start 60s round
            </button>
          ) : (
            <button type="button" onClick={stopGame}>
              Stop round
            </button>
          )}
        </div>
        <p>Permission: {motionPermission}</p>
        <p>Time left: {timeLeft}s</p>
        <p>Score: {gameScore} | Skips: {gameSkips}</p>
        <div className="word-card">{playing ? currentWord || 'Round complete' : 'Ready to play'}</div>
        <p className="hint">Tilt up = correct, tilt down = skip.</p>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel">
        <h2>Offline lists</h2>
        {offlineLists.length === 0 ? (
          <p>No downloaded lists yet.</p>
        ) : (
          <ul className="list-grid">
            {offlineLists.map((list) => (
              <li key={list.listId}>
                <h3>{list.title}</h3>
                <p>Words: {list.words.length}</p>
                <p>Saved: {new Date(list.downloadedAt).toLocaleString()}</p>
                <button type="button" onClick={() => removeOfflineList(list.listId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Cloud lists</h2>
        {lists.length === 0 ? (
          <p>No lists found yet.</p>
        ) : (
          <ul className="list-grid">
            {lists.map((list) => {
              const isOwner = list.ownerUserId === userId
              const isFavorite = favoriteIds.has(list.listId)
              return (
                <li key={list.listId}>
                  <h3>{list.title}</h3>
                  <p>Owner: {list.ownerUserId}</p>
                  <p>Words: {list.wordCount}</p>
                  <p>Version: {list.currentVersion}</p>
                  <p>Updated: {new Date(list.updatedAt).toLocaleString()}</p>
                  <div className="row">
                    <button type="button" onClick={() => downloadList(list.listId)}>
                      Download
                    </button>
                    <button type="button" onClick={() => toggleFavorite(list.listId)}>
                      {isFavorite ? 'Unfavorite' : 'Favorite'}
                    </button>
                  </div>
                  {isOwner ? (
                    <div className="row">
                      <button type="button" onClick={() => beginEdit(list.listId)}>
                        Edit
                      </button>
                      <button type="button" onClick={() => removeList(list.listId)}>
                        Delete
                      </button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}

export default App


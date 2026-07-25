import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

type TabKey = 'lists' | 'game' | 'effects'

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
const OFFLINE_LISTS_KEY = 'headsup_offline_lists'
const SOUND_ENABLED_KEY = 'headsup_sound_enabled'
const ANIMATIONS_ENABLED_KEY = 'headsup_animations_enabled'
const GAME_DURATION_SECONDS = 60
const CALIBRATION_WINDOW_MS = 900
const HOLD_TRIGGER_MS = 250
const HOLD_ANGLE_DEGREES = 14
const TILT_ANGLE_DEGREES = 18
const VELOCITY_TRIGGER_DPS = 95
const TRIGGER_COOLDOWN_MS = 900
const NEUTRAL_ANGLE_DEGREES = 8
const NEUTRAL_HOLD_MS = 180

type OrientationSample = {
  beta: number
  gamma: number
  at: number
}
const DEFAULT_COLOR_PACK: OfflineList = {
  listId: 'default-colors-pack',
  title: 'Basic Colors (Test Pack)',
  words: [
    'Red',
    'Blue',
    'Green',
    'Yellow',
    'Purple',
    'Orange',
    'Pink',
    'Black',
    'White',
    'Brown',
    'Grey',
    'Cyan',
    'Magenta',
    'Lime',
    'Navy',
    'Teal',
  ],
  downloadedAt: new Date().toISOString(),
}

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

function getScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle
  }
  return 0
}

function isLandscapeAngle(angle: number) {
  return angle === 90 || angle === 270 || angle === -90
}

async function readJsonOrNull(response: Response) {
  const text = await response.text()
  if (!text) {
    return null
  }
  return JSON.parse(text) as unknown
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('lists')
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
  const [selectedOfflineListId, setSelectedOfflineListId] = useState(DEFAULT_COLOR_PACK.listId)
  const [motionPermission, setMotionPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown')
  const [gameWords, setGameWords] = useState<string[]>([])
  const [gameIndex, setGameIndex] = useState(0)
  const [gameScore, setGameScore] = useState(0)
  const [gameSkips, setGameSkips] = useState(0)
  const [timeLeft, setTimeLeft] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [baselineBeta, setBaselineBeta] = useState<number | null>(null)
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [immersiveActive, setImmersiveActive] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<'idle' | 'correct' | 'skip'>('idle')
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [invertTilt, setInvertTilt] = useState(false)
  const [orientationAngle, setOrientationAngle] = useState(0)
  const [pose, setPose] = useState<{ beta: number; gamma: number } | null>(null)
  const [activeAxis, setActiveAxis] = useState<'beta' | 'gamma'>('gamma')
  const [baselinePair, setBaselinePair] = useState<{ beta: number; gamma: number } | null>(null)
  const [lastDelta, setLastDelta] = useState(0)
  const [lastVelocity, setLastVelocity] = useState(0)
  const [neutralReady, setNeutralReady] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [animationsEnabled, setAnimationsEnabled] = useState(true)
  const [error, setError] = useState('')

  const calibrationRef = useRef<{ start: number; sumBeta: number; sumGamma: number; count: number } | null>(null)
  const holdRef = useRef<{ kind: 'correct' | 'skip' | null; start: number }>({ kind: null, start: 0 })
  const lastOrientationRef = useRef<OrientationSample | null>(null)
  const latestOrientationRef = useRef<OrientationSample | null>(null)
  const neutralRef = useRef<{ start: number }>({ start: 0 })
  const lastTriggerRef = useRef(0)

  const apiBase = useMemo(() => normalizeApiBase(apiBaseInput), [apiBaseInput])
  const userId = userIdInput.trim()
  const currentWord = gameWords[gameIndex] ?? ''
  const selectedOfflineList = offlineLists.find((list) => list.listId === selectedOfflineListId) ?? null
  const landscapeReady = isLandscapeAngle(orientationAngle)
  const postureReady = useMemo(() => {
    if (!pose) {
      return false
    }
    return Math.abs(pose.beta) <= 45 && Math.abs(pose.gamma) <= 45
  }, [pose])

  useEffect(() => {
    const savedApiBase = localStorage.getItem('headsup_api_base') ?? DEFAULT_API_BASE
    const savedUserId = localStorage.getItem('headsup_user_id') ?? ''
    const savedOfflineLists = localStorage.getItem(OFFLINE_LISTS_KEY)
    const savedSoundEnabled = localStorage.getItem(SOUND_ENABLED_KEY)
    const savedAnimationsEnabled = localStorage.getItem(ANIMATIONS_ENABLED_KEY)
    setApiBaseInput(savedApiBase)
    setUserIdInput(savedUserId)
    setSoundEnabled(savedSoundEnabled !== 'false')
    setAnimationsEnabled(savedAnimationsEnabled !== 'false')

    if (savedOfflineLists) {
      const parsed = JSON.parse(savedOfflineLists) as OfflineList[]
      const merged = parsed.some((list) => list.listId === DEFAULT_COLOR_PACK.listId)
        ? parsed
        : [DEFAULT_COLOR_PACK, ...parsed]
      setOfflineLists(merged)
      setSelectedOfflineListId(merged[0].listId)
      localStorage.setItem(OFFLINE_LISTS_KEY, JSON.stringify(merged))
      return
    }

    setOfflineLists([DEFAULT_COLOR_PACK])
    setSelectedOfflineListId(DEFAULT_COLOR_PACK.listId)
    localStorage.setItem(OFFLINE_LISTS_KEY, JSON.stringify([DEFAULT_COLOR_PACK]))
  }, [])

  useEffect(() => {
    localStorage.setItem(SOUND_ENABLED_KEY, String(soundEnabled))
  }, [soundEnabled])

  useEffect(() => {
    localStorage.setItem(ANIMATIONS_ENABLED_KEY, String(animationsEnabled))
  }, [animationsEnabled])

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

  const playTone = useCallback((frequency: number, durationMs: number) => {
    if (!soundEnabled) {
      return
    }
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return
    }
    const audioContext = new AudioContextCtor()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.value = 0.08
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    window.setTimeout(() => {
      oscillator.stop()
      audioContext.close()
    }, durationMs)
  }, [soundEnabled])

  const applyOutcome = useCallback((kind: 'correct' | 'skip') => {
    setGameIndex((previous) => previous + 1)
    if (kind === 'correct') {
      setGameScore((previous) => previous + 1)
      playTone(880, 120)
    } else {
      setGameSkips((previous) => previous + 1)
      playTone(330, 120)
    }
    if (animationsEnabled) {
      setLastOutcome(kind)
      window.setTimeout(() => setLastOutcome('idle'), 350)
    }
  }, [animationsEnabled, playTone])

  const enterImmersiveMode = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      }
      if (screen.orientation && 'lock' in screen.orientation) {
        await screen.orientation.lock('landscape')
      }
      setImmersiveActive(Boolean(document.fullscreenElement))
      setOrientationAngle(getScreenAngle())
    } catch {
      setImmersiveActive(Boolean(document.fullscreenElement))
    }
  }, [])

  const exitImmersiveMode = useCallback(async () => {
    try {
      if (screen.orientation && 'unlock' in screen.orientation) {
        screen.orientation.unlock()
      }
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      }
    } catch {
      // Ignore; browsers vary by support.
    } finally {
      setImmersiveActive(Boolean(document.fullscreenElement))
      setOrientationAngle(getScreenAngle())
    }
  }, [])

  useEffect(() => {
    if (!playing) {
      return undefined
    }

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.beta !== 'number') {
        return
      }
      const gamma = typeof event.gamma === 'number' ? event.gamma : 0
      const now = Date.now()
      const angle = getScreenAngle()
      setOrientationAngle(angle)
      latestOrientationRef.current = { beta: event.beta, gamma, at: now }
      setPose({ beta: event.beta, gamma })

      if (baselineBeta === null) {
        const current = calibrationRef.current
        if (!current) {
          calibrationRef.current = { start: now, sumBeta: event.beta, sumGamma: gamma, count: 1 }
          return
        }
        current.sumBeta += event.beta
        current.sumGamma += gamma
        current.count += 1
        if (now - current.start >= CALIBRATION_WINDOW_MS && current.count >= 8) {
          const averaged = {
            beta: current.sumBeta / current.count,
            gamma: current.sumGamma / current.count,
          }
          setBaselinePair(averaged)
          setBaselineBeta(averaged.beta)
          setActiveAxis(isLandscapeAngle(angle) ? 'gamma' : 'beta')
          setIsCalibrating(false)
          calibrationRef.current = null
        }
        return
      }

      if (now - lastTriggerRef.current < TRIGGER_COOLDOWN_MS) {
        return
      }

      const axis = isLandscapeAngle(angle) ? 'gamma' : 'beta'
      const base = axis === 'gamma' ? (baselinePair?.gamma ?? 0) : baselineBeta
      const raw = axis === 'gamma' ? gamma : event.beta
      const axisSign = axis === 'gamma' && angle === 90 ? -1 : 1
      const userSign = invertTilt ? -1 : 1
      const delta = userSign * axisSign * (raw - base)
      const previousOrientation = lastOrientationRef.current
      let velocityDps = 0
      if (previousOrientation) {
        const elapsedMs = Math.max(1, now - previousOrientation.at)
        const previousRaw = axis === 'gamma' ? previousOrientation.gamma : previousOrientation.beta
        velocityDps = (userSign * axisSign * (raw - previousRaw) / elapsedMs) * 1000
      }
      lastOrientationRef.current = { beta: event.beta, gamma, at: now }
      setActiveAxis(axis)
      if (debugEnabled) {
        setLastDelta(delta)
        setLastVelocity(velocityDps)
      }

      if (!neutralReady) {
        if (Math.abs(delta) <= NEUTRAL_ANGLE_DEGREES) {
          if (neutralRef.current.start === 0) {
            neutralRef.current.start = now
          } else if (now - neutralRef.current.start >= NEUTRAL_HOLD_MS) {
            setNeutralReady(true)
            neutralRef.current.start = 0
          }
        } else {
          neutralRef.current.start = 0
        }
        return
      }

      const velocityTrigger = Math.abs(delta) >= TILT_ANGLE_DEGREES && Math.abs(velocityDps) >= VELOCITY_TRIGGER_DPS
      if (velocityTrigger) {
        lastTriggerRef.current = now
        setNeutralReady(false)
        neutralRef.current.start = 0
        holdRef.current = { kind: null, start: 0 }
        applyOutcome(delta < 0 ? 'correct' : 'skip')
        return
      }

      let holdKind: 'correct' | 'skip' | null = null
      if (delta <= -HOLD_ANGLE_DEGREES) {
        holdKind = 'correct'
      } else if (delta >= HOLD_ANGLE_DEGREES) {
        holdKind = 'skip'
      }

      const hold = holdRef.current
      if (!holdKind) {
        holdRef.current = { kind: null, start: 0 }
        return
      }
      if (hold.kind !== holdKind) {
        holdRef.current = { kind: holdKind, start: now }
        return
      }

      if (now - hold.start >= HOLD_TRIGGER_MS && Math.abs(delta) >= TILT_ANGLE_DEGREES) {
        lastTriggerRef.current = now
        setNeutralReady(false)
        neutralRef.current.start = 0
        holdRef.current = { kind: null, start: 0 }
        applyOutcome(holdKind)
      }
    }

    window.addEventListener('deviceorientation', onOrientation)
    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [applyOutcome, baselineBeta, baselinePair?.gamma, debugEnabled, invertTilt, neutralReady, playing])

  useEffect(() => {
    if (!playing) {
      return
    }
    if (gameIndex >= gameWords.length && gameWords.length > 0) {
      setPlaying(false)
    }
  }, [gameIndex, gameWords.length, playing])

  useEffect(() => {
    if (playing) {
      return
    }
    if (immersiveActive) {
      void exitImmersiveMode()
    }
  }, [exitImmersiveMode, immersiveActive, playing])

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

  async function requestMotionPermission(): Promise<'unknown' | 'granted' | 'denied'> {
    try {
      const maybeRequest = (
        DeviceOrientationEvent as unknown as {
          requestPermission?: () => Promise<'granted' | 'denied'>
        }
      ).requestPermission

      if (typeof maybeRequest === 'function') {
        const result = await maybeRequest()
        setMotionPermission(result)
        return result
      }
      setMotionPermission('granted')
      return 'granted'
    } catch {
      setMotionPermission('denied')
      setError('Motion permission was denied.')
      return 'denied'
    }
  }

  async function startGame() {
    if (!selectedOfflineList || selectedOfflineList.words.length === 0) {
      setError('Select a downloaded list with words first.')
      return
    }

    const permissionResult = motionPermission === 'unknown' ? await requestMotionPermission() : motionPermission
    if (permissionResult === 'denied') {
      setError('Motion permission is required to start.')
      return
    }
    if (!isLandscapeAngle(getScreenAngle())) {
      setError('Rotate phone to landscape before starting.')
      return
    }

    const sample = pose ?? latestOrientationRef.current
    if (!sample || Math.abs(sample.beta) > 45 || Math.abs(sample.gamma) > 45) {
      setError('Hold the phone level in landscape before starting.')
      return
    }

    await enterImmersiveMode()

    setError('')
    setGameWords(shuffleWords(selectedOfflineList.words))
    setGameIndex(0)
    setGameScore(0)
    setGameSkips(0)
    setTimeLeft(GAME_DURATION_SECONDS)
    setBaselineBeta(null)
    setBaselinePair(null)
    setOrientationAngle(getScreenAngle())
    setIsCalibrating(true)
    setNeutralReady(true)
    setLastOutcome('idle')
    calibrationRef.current = null
    holdRef.current = { kind: null, start: 0 }
    lastOrientationRef.current = null
    neutralRef.current = { start: 0 }
    lastTriggerRef.current = 0
    setPlaying(true)
  }

  async function stopGame() {
    setPlaying(false)
    setIsCalibrating(false)
    await exitImmersiveMode()
  }

  function saveConnectionDetails() {
    localStorage.setItem('headsup_api_base', apiBase)
    localStorage.setItem('headsup_user_id', userId)
    setError('')
  }

  return (
    <main className={`app ${playing ? 'playing' : ''}`}>
      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'lists' ? 'active' : ''}
          onClick={() => setActiveTab('lists')}
        >
          Lists
        </button>
        <button
          type="button"
          className={activeTab === 'game' ? 'active' : ''}
          onClick={() => setActiveTab('game')}
        >
          Game
        </button>
        <button
          type="button"
          className={activeTab === 'effects' ? 'active' : ''}
          onClick={() => setActiveTab('effects')}
        >
          Sound + Animation
        </button>
      </nav>

      {activeTab === 'lists' ? (
        <>
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
        </>
      ) : null}

      {activeTab === 'game' ? (
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
              <button type="button" onClick={() => void startGame()}>
                Start 60s round
              </button>
            ) : (
              <button type="button" onClick={() => void stopGame()}>
                Stop round
              </button>
            )}
          </div>
          <p>Landscape ready: {landscapeReady ? 'yes' : 'no'}</p>
          <p>Posture ready: {postureReady ? 'yes' : 'no'}</p>
          <p>Immersive mode: {immersiveActive ? 'active' : 'inactive'}</p>
          <p>Calibration: {isCalibrating ? 'Hold steady...' : baselineBeta === null ? 'not started' : 'ready'}</p>
          <p>Permission: {motionPermission}</p>
          <p>Time left: {timeLeft}s</p>
          <p>Score: {gameScore} | Skips: {gameSkips}</p>
          <div className={`word-card ${lastOutcome}`}>{playing ? currentWord || 'Round complete' : 'Ready to play'}</div>
          <p className="hint">Tilt up = correct, tilt down = skip.</p>
        </section>
      ) : null}

      {activeTab === 'effects' ? (
        <section className="panel">
          <h2>Sound + Animation</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(event) => setSoundEnabled(event.target.checked)}
            />
            Sound effects
          </label>
          <div className="row">
            <button type="button" onClick={() => playTone(880, 120)}>
              Test correct sound
            </button>
            <button type="button" onClick={() => playTone(330, 120)}>
              Test skip sound
            </button>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={animationsEnabled}
              onChange={(event) => setAnimationsEnabled(event.target.checked)}
            />
            Card flash animation
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={invertTilt}
              onChange={(event) => setInvertTilt(event.target.checked)}
            />
            Invert tilt direction
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={debugEnabled}
              onChange={(event) => setDebugEnabled(event.target.checked)}
            />
            Show gyro debug
          </label>
          {debugEnabled ? (
            <div className="debug">
              <p>Angle: {orientationAngle}</p>
              <p>Axis: {activeAxis}</p>
              <p>Neutral ready: {neutralReady ? 'yes' : 'no'}</p>
              <p>Baseline beta: {baselinePair ? baselinePair.beta.toFixed(2) : 'n/a'}</p>
              <p>Baseline gamma: {baselinePair ? baselinePair.gamma.toFixed(2) : 'n/a'}</p>
              <p>Delta: {lastDelta.toFixed(2)}</p>
              <p>Velocity: {lastVelocity.toFixed(2)} deg/s</p>
            </div>
          ) : null}
          <p className="hint">
            Current plan: keep lightweight built-in effects only (CSS + WebAudio). Add richer assets later only if needed.
          </p>
        </section>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </main>
  )
}

export default App

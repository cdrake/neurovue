// Drives OBS over its built-in WebSocket server (obs-websocket 5), so the demo
// can be recorded as a fallback. Run with bun:
//
//   bun demo/codex/obs.ts setup    # a "NeuroVue demo" scene with the screen
//   bun demo/codex/obs.ts start    # start recording that scene
//   bun demo/codex/obs.ts stop     # stop; prints the file it wrote
//   bun demo/codex/obs.ts status
//
// The password is read from OBS's own config unless OBS_PASSWORD is set.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const SCENE = process.env.OBS_SCENE ?? 'NeuroVue demo'
const SOURCE = process.env.OBS_SOURCE ?? 'macOS Screen Capture'
const config = `${homedir()}/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json`

function settings(): { port: number; password: string } {
  try {
    const c = JSON.parse(readFileSync(config, 'utf8'))
    return {
      port: Number(process.env.OBS_PORT ?? c.server_port ?? 4455),
      password: process.env.OBS_PASSWORD ?? c.server_password ?? '',
    }
  } catch {
    return {
      port: Number(process.env.OBS_PORT ?? 4455),
      password: process.env.OBS_PASSWORD ?? '',
    }
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64')

type Reply = { result: boolean; code: number; comment?: string; data: any }

/** Connects and identifies; returns a request function and a close. */
async function connect() {
  const { port, password } = settings()
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map<string, (r: Reply) => void>()
  let next = 0
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () =>
      reject(
        new Error(
          `OBS isn't answering on port ${port}. Open OBS and check Tools > WebSocket Server Settings.`,
        ),
      )
    ws.onmessage = (event) => {
      const { op, d } = JSON.parse(String(event.data))
      if (op === 0) {
        const auth = d.authentication
        ws.send(
          JSON.stringify({
            op: 1,
            d: {
              rpcVersion: 1,
              ...(auth && {
                authentication: sha(sha(password + auth.salt) + auth.challenge),
              }),
            },
          }),
        )
      } else if (op === 2) resolve()
      else if (op === 7) {
        pending.get(d.requestId)?.({
          result: d.requestStatus.result,
          code: d.requestStatus.code,
          comment: d.requestStatus.comment,
          data: d.responseData,
        })
        pending.delete(d.requestId)
      }
    }
    ws.onclose = (event) =>
      reject(new Error(`OBS closed the connection: ${event.reason || event.code}`))
  })
  const call = (requestType: string, requestData?: object) =>
    new Promise<Reply>((resolve, reject) => {
      const requestId = String(++next)
      const timer = setTimeout(
        () => reject(new Error(`${requestType}: OBS didn't answer in 15 s.`)),
        15000,
      )
      pending.set(requestId, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
    })
  const must = async (type: string, data?: object) => {
    const r = await call(type, data)
    if (!r.result) throw new Error(`${type}: ${r.comment ?? `code ${r.code}`}`)
    return r.data
  }
  return { call, must, close: () => ws.close() }
}

const obs = await connect()
try {
  switch (process.argv[2]) {
    case 'setup': {
      const { scenes } = await obs.must('GetSceneList')
      if (!scenes.some((s: { sceneName: string }) => s.sceneName === SCENE)) {
        await obs.must('CreateScene', { sceneName: SCENE })
        await obs.must('CreateSceneItem', { sceneName: SCENE, sourceName: SOURCE })
      }
      // Fit the whole screen in the canvas; a Retina capture is drawn at
      // full size otherwise, which records only its top-left corner.
      const { baseWidth, baseHeight } = await obs.must('GetVideoSettings')
      const { sceneItemId } = await obs.must('GetSceneItemId', {
        sceneName: SCENE,
        sourceName: SOURCE,
      })
      await obs.must('SetSceneItemTransform', {
        sceneName: SCENE,
        sceneItemId,
        sceneItemTransform: {
          positionX: 0,
          positionY: 0,
          boundsType: 'OBS_BOUNDS_SCALE_INNER',
          boundsAlignment: 0,
          boundsWidth: baseWidth,
          boundsHeight: baseHeight,
        },
      })
      await obs.must('SetCurrentProgramScene', { sceneName: SCENE })
      console.log(`Recording scene: ${SCENE} (${SOURCE})`)
      break
    }
    case 'start': {
      await obs.must('SetCurrentProgramScene', { sceneName: SCENE })
      const r = await obs.call('StartRecord')
      // 500: already recording, which is fine for a fallback.
      if (!r.result && r.code !== 500) throw new Error(`StartRecord: ${r.comment}`)
      console.log('Recording.')
      break
    }
    case 'stop': {
      const r = await obs.call('StopRecord')
      if (!r.result) throw new Error(`StopRecord: ${r.comment ?? 'not recording'}`)
      console.log(r.data.outputPath)
      break
    }
    case 'status': {
      const s = await obs.must('GetRecordStatus')
      console.log(s.outputActive ? `Recording, ${s.outputTimecode}` : 'Not recording.')
      break
    }
    case 'shot': {
      // A still of the scene, to check the capture isn't black before the demo.
      const { imageData } = await obs.must('GetSourceScreenshot', {
        sourceName: SCENE,
        imageFormat: 'png',
        imageWidth: 960,
      })
      const out = process.argv[3] ?? 'obs-check.png'
      await Bun.write(out, Buffer.from(imageData.split(',')[1], 'base64'))
      console.log(out)
      break
    }
    default:
      console.log('usage: bun demo/codex/obs.ts setup|start|stop|status|shot [file]')
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  obs.close()
}

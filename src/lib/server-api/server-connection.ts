import * as Promise from 'bluebird'
import {ChildProcess} from 'child_process'
import {EventEmitter} from 'events'
import * as loglevel from 'loglevel'
import {WebsocketClient} from '../network/NetworkClient'
import {Event, Typehinted} from '../server-api/server-protocol'

const log = loglevel.getLogger('ensime.client')

export type CallId = number
export type CallbackMap = Map<CallId, Promise.Resolver<any>>
export type EventHandler = (ev: Event) => void
export type Cancellable = () => void

/**
 * A running and connected ensime client
 *
 * low-level api
 */
export class ServerConnection {
    public readonly httpPort: string
    private client: WebsocketClient
    private serverProcess?: ChildProcess
    private callbackMap: CallbackMap
    private serverEvents: EventEmitter
    private ensimeMessageCounter = 1

    constructor(httpPort: string, client: WebsocketClient, callbackMap: CallbackMap, serverEvents: EventEmitter, serverProcess?: ChildProcess) {
        this.httpPort = httpPort
        this.client = client
        this.callbackMap = callbackMap
        this.serverEvents = serverEvents
        this.serverProcess = serverProcess
    }

    /**
     * Register a listener to handle any asyncronic messages
     * @param  {EventHandler} listener
     * @param  {boolean} once if it's true, the listener is only going to be executed once
     * @return {Cancellable} returns a function to remove the listener, when it is executed
     */
    public onEvents(listener: EventHandler, once: boolean = false): Cancellable {
        if (!once) {
            this.serverEvents.on('events', listener)
        } else {
            this.serverEvents.once('events', listener)
        }
        return () => this.serverEvents.removeListener('events', listener)
    }

    /**
     * Post a msg object
     */
    public post<T extends Typehinted>(msg: any): PromiseLike<T> {
        const p = Promise.defer<T>()
        const wireMsg = `{"req": ${JSON.stringify(msg)}, "callId": ${this.ensimeMessageCounter}}`
        this.callbackMap.set(this.ensimeMessageCounter++, p)
        log.debug('outgoing: ' + wireMsg)
        this.client.send(wireMsg)
        return p.promise
    }

    public destroy(): PromiseLike<number> {
        this.client.destroy()
        if (this.serverProcess) {
            return this.killServer()
        }
        return Promise.resolve(0)
    }

    private killServer(): PromiseLike<number> {
        const p = Promise.defer<number>()
        this.serverProcess.on('close', code => {
            p.resolve(code)
        })
        this.serverProcess.kill()
        return p.promise
    }
}

export function createConnection(httpPort: string, serverProcess?: ChildProcess): PromiseLike<ServerConnection> {
    const callbackMap: CallbackMap = new Map()
    const serverEvents: EventEmitter = new EventEmitter()

    serverEvents.setMaxListeners(50)

    function handleIncoming(msg) {
        const json = JSON.parse(msg)
        log.debug('incoming: ', json)
        const callId = json.callId
        // If RpcResponse - lookup in map, otherwise use some general function for handling general msgs

        if (callId) {
            try {
                const p = callbackMap.get(callId)
                log.debug('resolving promise: ' + p)
                p.resolve(json.payload)
            } catch (error) {
                log.trace(`error in callback: ${error}`)
            } finally {
                callbackMap.delete(callId)
            }
        } else {
            serverEvents.emit('events', json.payload)
        }
    }

    return WebsocketClient.new(httpPort, handleIncoming).then(ws => new ServerConnection(httpPort, ws, callbackMap, serverEvents, serverProcess))
}

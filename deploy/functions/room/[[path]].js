import { serveR2 } from '../../lib/shared.js'

export const onRequestGet = ({ env, request, params }) => serveR2(env, request, 'room', params.path)
export const onRequestHead = onRequestGet

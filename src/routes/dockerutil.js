import { ValidationError } from '../validate.js';
import { selfId } from '../docker.js';

// shared by the docker routers
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;
export const idParam = (v) => { if (!ID_RE.test(v)) throw new ValidationError('Invalid id'); return v; };
/** True if `id` (name, short or full id) is the panel's own container. */
export const isSelf = (id) => { const me = selfId(); return id.length >= 4 && (me.startsWith(id) || id.startsWith(me)); };
export const q = (o) => new URLSearchParams(o).toString();

import { Type } from '@earendil-works/pi-ai';
import { install, toolSchema } from '../src/extension.js';

export default function piTalk(pi) {
  install(pi, toolSchema(Type));
}

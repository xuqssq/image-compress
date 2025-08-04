import { compressImages } from './dist/index.cjs'

const res = await compressImages({
  directory: 'public',
  silent: false
})

console.log(res)

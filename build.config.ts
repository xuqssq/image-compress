import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['./src/index'],
  outDir: 'dist',
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: true,
    output: {
      exports: 'named'
    },
    esbuild: {
      minify: true
    }
  },
  externals: ['@napi-rs/image', 'chalk', 'consola']
})

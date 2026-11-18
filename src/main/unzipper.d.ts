declare module 'unzipper' {
  export const Open: {
    file(path: string): Promise<{ files: Array<{
      type: 'File' | 'Directory'
      path: string
      externalFileAttributes: number
      uncompressedSize: number
      stream(): NodeJS.ReadableStream
    }> }>
  }
}

export interface WeatherData {
  city: string
  temperatureC: number
  condition: string
  observedAt: string
}

export interface WeatherProvider {
  getCurrentWeather: (
    input: { city: string },
    options: { signal: AbortSignal },
  ) => Promise<WeatherData>
}

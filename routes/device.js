import express from "express"
import zktecoService from "../services/zktecoService.js"

const router = express.Router()

// Connect to device
router.post("/connect", async (req, res, next) => {
  try {
    const customConfig = req.body.config || null
    const result = await zktecoService.connect(customConfig)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

// Disconnect from device
router.post("/disconnect", async (req, res, next) => {
  try {
    const result = await zktecoService.disconnect()
    res.json(result)
  } catch (error) {
    next(error)
  }
})

// Get device information
router.get("/info", async (req, res, next) => {
  try {
    const result = await zktecoService.getDeviceInfo()
    res.json(result)
  } catch (error) {
    next(error)
  }
})

// Get device time
router.get("/time", async (req, res, next) => {
  try {
    const result = await zktecoService.getDeviceTime()
    res.json(result)
  } catch (error) {
    next(error)
  }
})

// Set device time
router.put("/time", async (req, res, next) => {
  try {
    const { timestamp } = req.body
    const result = await zktecoService.setDeviceTime(timestamp)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

// Get connection status
router.get("/status", (req, res) => {
  res.json({
    success: true,
    data: {
      connected: zktecoService.isConnected,
      timestamp: new Date().toISOString(),
    },
  })
})

export default router



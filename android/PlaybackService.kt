package com.example.room

import android.app.*
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat

// Foreground service holding a MediaSession so audio + lock-screen controls survive backgrounding.
// build.gradle: implementation "androidx.media:media:1.7.0"
class PlaybackService : Service() {
  private lateinit var session: MediaSessionCompat

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java)
        .createNotificationChannel(NotificationChannel(CH, "Room playback", NotificationManager.IMPORTANCE_LOW))
    }
    session = MediaSessionCompat(this, "room").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onSkipToNext() { skipHook?.invoke() }     // same vote as the in-app button
        override fun onPause() { pauseHook?.invoke() }
      })
      setPlaybackState(PlaybackStateCompat.Builder()
        .setActions(PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_PAUSE)
        .setState(PlaybackStateCompat.STATE_PLAYING, 0, 1f).build())
      isActive = true
    }
    val n = NotificationCompat.Builder(this, CH)
      .setContentTitle("Room").setSmallIcon(android.R.drawable.ic_media_play)
      .setStyle(androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(session.sessionToken))
      .build()
    startForeground(1, n)
  }

  override fun onBind(i: Intent?): IBinder? = null
  override fun onDestroy() { session.release(); super.onDestroy() }

  companion object {
    private const val CH = "room_playback"
    @Volatile private var p = 0.0
    var seekHook: ((Long) -> Unit)? = null
    var pauseHook: (() -> Unit)? = null
    var skipHook: (() -> Unit)? = null
    fun pos(): Double = p
    fun setPos(v: Double) { p = v }
    fun seek(ms: Long) { seekHook?.invoke(ms) }
    fun pause() { pauseHook?.invoke() }
  }
}

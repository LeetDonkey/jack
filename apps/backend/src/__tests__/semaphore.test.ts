import { describe, expect, test } from 'bun:test'
import { Semaphore } from '../lib/semaphore'

describe('Semaphore', () => {
  test('limits concurrency to the permit count', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0
    const task = () => sem.run(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(10)
      active--
    })
    await Promise.all(Array.from({ length: 6 }, task))
    expect(maxActive).toBe(2)
  })

  test('hands permits to waiters in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    await sem.acquire()
    const waiters = [1, 2, 3].map(n => sem.acquire().then(() => {
      order.push(n)
    }))
    sem.release()
    sem.release()
    sem.release()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })

  test('a front waiter is admitted before earlier waiters', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    await sem.acquire()
    const waiters = [
      sem.acquire().then(() => order.push(1)),
      sem.acquire().then(() => order.push(2)),
      sem.acquire(undefined, { front: true }).then(() => order.push(3)),
    ]
    sem.release()
    sem.release()
    sem.release()
    await Promise.all(waiters)
    expect(order).toEqual([3, 1, 2])
  })

  test('releases the permit when the task throws', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const ran = await sem.run(async () => 'next')
    expect(ran).toBe('next')
  })

  test('removes an aborted waiter without consuming the next released permit', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const controller = new AbortController()
    const aborted = sem.acquire(controller.signal)
    const next = sem.acquire()

    controller.abort(new Error('cancelled while queued'))
    await expect(aborted).rejects.toThrow('cancelled while queued')
    sem.release()
    await next
  })

  test('does not run work when its signal aborts while queued', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const controller = new AbortController()
    let ran = false
    const queued = sem.run(async () => {
      ran = true
    }, controller.signal)

    controller.abort(new Error('cancelled while queued'))
    await expect(queued).rejects.toThrow('cancelled while queued')
    expect(ran).toBe(false)
    sem.release()
  })

  test('rejects a non-positive permit count', () => {
    expect(() => new Semaphore(0)).toThrow()
  })

  test('raising the limit admits queued waiters right away', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    let admitted = 0
    const waiters = [sem.acquire(), sem.acquire()].map(p => p.then(() => admitted++))

    sem.setPermits(3)
    await Promise.all(waiters)
    expect(admitted).toBe(2)
  })

  test('lowering the limit lets holders finish and delays new admissions', async () => {
    const sem = new Semaphore(3)
    await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()])
    sem.setPermits(1)

    let admitted = false
    const waiter = sem.acquire().then(() => {
      admitted = true
    })
    sem.release()
    sem.release()
    await Bun.sleep(0)
    expect(admitted).toBe(false) // two releases only paid back the lowered limit

    sem.release()
    await waiter
    expect(admitted).toBe(true)
  })

  test('setPermits rejects a non-positive permit count', () => {
    expect(() => new Semaphore(1).setPermits(0)).toThrow()
  })
})

describe('Semaphore pause', () => {
  test('a paused semaphore admits nobody new; holders keep their permits', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    sem.setPaused(true)
    expect(sem.isPaused).toBe(true)
    let admitted = 0
    const waiters = [sem.acquire().then(() => admitted++), sem.acquire().then(() => admitted++)]
    await Bun.sleep(5)
    expect(admitted).toBe(0)

    // A release while paused returns the permit instead of handing it on.
    sem.release()
    await Bun.sleep(5)
    expect(admitted).toBe(0)

    sem.setPaused(false)
    await Promise.all(waiters)
    expect(admitted).toBe(2)
  })

  test('waiters keep their order across a pause, and an aborted waiter leaves the queue', async () => {
    const sem = new Semaphore(1)
    sem.setPaused(true)
    const order: number[] = []
    const controller = new AbortController()
    const first = sem.acquire().then(() => order.push(1))
    const aborted = sem.acquire(controller.signal).catch(() => order.push(-1))
    controller.abort(new Error('cancelled'))
    await aborted
    const second = sem.acquire().then(() => order.push(2))
    sem.setPaused(false)
    await first
    sem.release()
    await second
    expect(order).toEqual([-1, 1, 2])
  })
})

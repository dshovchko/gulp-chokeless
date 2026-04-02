import { describe, it, expect, beforeEach } from 'vitest';
import { FastQueue } from '../src/fast-queue';

describe('FastQueue', () => {
  let queue: FastQueue<number>;

  beforeEach(() => {
    queue = new FastQueue<number>();
  });

  it('should initialize with length 0', () => {
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });

  it('should push a single item correctly', () => {
    queue.push(42);
    expect(queue.length).toBe(1);
    expect(queue.shift()).toBe(42);
    expect(queue.length).toBe(0);
  });

  it('should maintain FIFO order with multiple items', () => {
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(queue.length).toBe(3);

    expect(queue.shift()).toBe(1);
    expect(queue.length).toBe(2);

    expect(queue.shift()).toBe(2);
    expect(queue.shift()).toBe(3);
    expect(queue.length).toBe(0);
  });

  it('should handle rapid push and shift operations', () => {
    queue.push(10);
    expect(queue.shift()).toBe(10);
    
    queue.push(20);
    queue.push(30);
    expect(queue.shift()).toBe(20);
    
    queue.push(40);
    expect(queue.shift()).toBe(30);
    expect(queue.shift()).toBe(40);
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });

  it('should not break if shifting when empty', () => {
    expect(queue.shift()).toBeUndefined();
    expect(queue.length).toBe(0);
    
    // Add item after empty shifts to ensure head/tail pointers are reset properly
    queue.push(100);
    expect(queue.length).toBe(1);
    expect(queue.shift()).toBe(100);
  });
});

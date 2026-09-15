// Package hsfair implements aggregate per-user/per-inbound byte pacing.
package hsfair

import (
 "context"
 "encoding/json"
 "fmt"
 "os"
 "path/filepath"
 "strings"
 "sync"
 "time"
)

type Manifest struct {
 Revision string `json:"revision"`
 Rates map[string]int64 `json:"rates"`
}
type bucket struct { next time.Time; touched time.Time }
type Manager struct {
 mu sync.Mutex
 rates map[string]int64
 buckets map[string]*bucket
 revision string
 changed chan struct{}
}
func New() *Manager { return &Manager{rates:map[string]int64{},buckets:map[string]*bucket{},changed:make(chan struct{})} }
func Key(email,tag string) string { return strings.SplitN(email,"~hspg~",2)[0]+"\x00"+tag }
func (m *Manager) Load(data []byte) error {
 var v Manifest
 if err:=json.Unmarshal(data,&v);err!=nil{return err}
 if len(v.Revision)!=64||v.Rates==nil||len(v.Rates)>100000{return fmt.Errorf("invalid HS manifest")}
 for key,rate:=range v.Rates { if len(key)>512||!strings.Contains(key,"\x00")||rate<1||rate>12500000000{return fmt.Errorf("invalid HS rate")} }
 m.mu.Lock();defer m.mu.Unlock()
 for key:=range m.buckets {if m.rates[key]!=v.Rates[key]{delete(m.buckets,key)}}
 m.rates=v.Rates;m.revision=v.Revision
 close(m.changed);m.changed=make(chan struct{})
 // Preserve pacing debt across a lower rate or refresh: opening more sessions cannot reset it.
 for key,b:=range m.buckets {if _,ok:=m.rates[key];!ok||time.Since(b.touched)>time.Minute {delete(m.buckets,key)}}
 return nil
}
// Wait is shared across upload, download and simultaneous sessions. At most one
// 2 KiB quantum is scheduled per caller; cancellation does not create free tokens.
func (m *Manager) Wait(ctx context.Context,key string,n int) error {
 for n>0 {
  select {case <-ctx.Done():return ctx.Err();default:}
  q:=n;if q>2048{q=2048}
  m.mu.Lock();rate:=m.rates[key]
  if rate==0 {m.mu.Unlock();return nil}
  quantum:=int(rate/20);if quantum<1{quantum=1};if q>quantum{q=quantum}
  changed:=m.changed
  now:=time.Now();b:=m.buckets[key];if b==nil{b=&bucket{};m.buckets[key]=b}
  start:=b.next;if start.Before(now){start=now}
  due:=start.Add(time.Duration(float64(q)/float64(rate)*float64(time.Second)))
  b.next=due;b.touched=now;m.mu.Unlock()
  timer:=time.NewTimer(time.Until(due))
  restart:=false
 waiting:
  for {select {
   case <-ctx.Done():timer.Stop();return ctx.Err()
   case <-timer.C:break waiting
   case <-changed:
    m.mu.Lock();newRate:=m.rates[key];changed=m.changed;m.mu.Unlock()
    if newRate!=rate {timer.Stop();restart=true;break waiting}
  }}
  if !restart{n-=q}
 }
 return nil
}
var Default=New()
func init(){
 path:=os.Getenv("HS_FAIR_POLICY_FILE");if path==""{path="/var/lib/hs-pg-agent/fair-policy.json"}
 go func(){
  var last string
  for {
   if data,err:=os.ReadFile(path);err==nil {
    if string(data)!=last {if Default.Load(data)==nil{last=string(data)}}
    Default.mu.Lock();revision:=Default.revision;Default.mu.Unlock()
    if revision!="" {
     ack,_:=json.Marshal(map[string]any{"adapter":"hs-rate-v1","revision":revision,"updated_at":time.Now().Unix(),"pid":os.Getpid()})
     tmp:=filepath.Join(filepath.Dir(path),fmt.Sprintf(".fair-ack-%d",os.Getpid()))
     if os.WriteFile(tmp,ack,0600)==nil{_ =os.Rename(tmp,path+".ack")}
    }
   }
   time.Sleep(time.Second)
  }
 }()
}

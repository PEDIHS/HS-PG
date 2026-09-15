package hsfair
import("context";"fmt";"strings";"sync";"testing";"time")
func manifest(rate int64) []byte{return []byte(fmt.Sprintf(`{"revision":"%s","rates":{"7\u0000in":%d}}`,strings.Repeat("a",64),rate))}
func TestAggregateAndIsolation(t *testing.T){m:=New();if e:=m.Load(manifest(20000));e!=nil{t.Fatal(e)};start:=time.Now();var wg sync.WaitGroup;for i:=0;i<4;i++{wg.Add(1);go func(){defer wg.Done();if e:=m.Wait(context.Background(),Key("7~hspg~abc","in"),2500);e!=nil{t.Error(e)}}()};wg.Wait();if time.Since(start)<450*time.Millisecond{t.Fatal("concurrent sessions bypass aggregate limit")};start=time.Now();m.Wait(context.Background(),Key("8","in"),10000);m.Wait(context.Background(),Key("7","other"),10000);if time.Since(start)>100*time.Millisecond{t.Fatal("unrelated user/inbound limited")}}
func TestCancelAndUpdate(t *testing.T){m:=New();m.Load(manifest(1250));ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel();if m.Wait(ctx,Key("7","in"),2000)==nil{t.Fatal("cancel ignored")};if m.Load([]byte(`{"revision":"bad","rates":{}}`))==nil{t.Fatal("invalid accepted")};if m.rates[Key("7","in")]!=1250{t.Fatal("invalid reset policy")};m.Load([]byte(fmt.Sprintf(`{"revision":"%s","rates":{}}`,strings.Repeat("b",64))));if e:=m.Wait(context.Background(),Key("7","in"),10000);e!=nil{t.Fatal(e)}}

func TestPolicyChangeReachesExistingSession(t *testing.T) {
 m:=New();m.Load(manifest(1250))
 ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel()
 done:=make(chan error,1)
 go func(){done<-m.Wait(ctx,Key("7","in"),100000)}()
 time.Sleep(30*time.Millisecond)
 m.Load([]byte(fmt.Sprintf(`{"revision":"%s","rates":{}}`,strings.Repeat("b",64))))
 select {case err:=<-done:if err!=nil{t.Fatal(err)};case <-time.After(200*time.Millisecond):t.Fatal("existing session did not observe policy removal")}
}
